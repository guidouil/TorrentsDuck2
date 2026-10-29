import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { RequestEvent } from '@sveltejs/kit';
import { parseStudioSrt, type StudioClip } from '../src/lib/studio';

const mocked = vi.hoisted(() => ({ query: vi.fn(), clientQuery: vi.fn(), storage: vi.fn() }));
vi.mock('../src/lib/server/db', () => ({ query: mocked.query, transaction: (run: (client: unknown) => unknown) => run({ query: mocked.clientQuery }) }));
vi.mock('../src/lib/server/storage', () => ({ requireStorage: mocked.storage }));
import { createStudioJob, deleteStudioJob, ownedStudioJob, ownedStudioProject, publishStudioJob, sourceFingerprint, studioFile, studioJobDirectory, studioOutput, validateStudioDubbing, validateStudioEdit } from '../src/lib/server/studio';

const id = '791b3f30-6e8b-44cb-960e-f8b723160833';
const jobId = '791b3f30-6e8b-44cb-960e-f8b723160834';
const clip: StudioClip = { space: 'downloads', path: 'film.mp4', start: 3, end: 8, audio: 1, x: 0.5, y: 0.5, title: 'Été 🦆', fingerprint: 'a'.repeat(64) };
const edit = () => ({ name: 'Extrait', aspect: '9:16', clips: [{ ...clip }], subtitles: '' });
const completed = { id: jobId, projectId: id, kind: 'export', status: 'completed', progress: 100, result: null, error: null };
let root: string;

beforeEach(async () => {
	root = await realpath(await mkdtemp(path.join(tmpdir(), 'duck-studio-')));
	for (const directory of ['downloads', 'share', 'studio']) await mkdir(path.join(root, directory));
	vi.stubEnv('DATA_ROOT', root); vi.stubEnv('STUDIO_DIR', path.join(root, 'studio'));
	vi.stubEnv('DOWNLOADS_DIR', path.join(root, 'downloads')); vi.stubEnv('SHARE_DIR', path.join(root, 'share'));
	vi.stubEnv('FILE_DELIVERY', 'node');
	mocked.query.mockReset().mockResolvedValue([]); mocked.clientQuery.mockReset(); mocked.storage.mockReset().mockResolvedValue({});
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); vi.unstubAllEnvs(); });

describe('Studio edit validation', () => {
	it('accepts a short montage and keeps source audio indices, crop and Unicode text', () => {
		expect(validateStudioEdit(edit())).toEqual(edit());
		expect(validateStudioEdit({ ...edit(), clips: [{ ...clip, start: 0, end: 300 }] }).clips[0].end).toBe(300);
	});
	it.each([
		{ end: 304 }, { start: 8 }, { start: -1 }, { end: NaN }, { x: 1.1 }, { audio: '1' }, { audio: -1 },
		{ path: '../private.mp4' }, { path: '/etc/passwd.mp4' }, { path: 'list.m3u8' }, { fingerprint: '' }, { title: 'x\u0000' }
	])('rejects unsafe or invalid clips %j', (changes) => {
		expect(() => validateStudioEdit({ ...edit(), clips: [{ ...clip, ...changes }] })).toThrow();
	});
	it('limits the sum of multiple clips, including repeated sources', () => {
		expect(() => validateStudioEdit({ ...edit(), clips: [{ ...clip, start: 0, end: 200 }, { ...clip, start: 0, end: 101 }] })).toThrow();
	});
	it('parses final-timeline SRT as plain text, preserving Unicode and stripping the BOM', () => {
		expect(parseStudioSrt('\uFEFF1\r\n00:00:00,500 --> 00:00:02,000\r\nÉté {\\pos(1,2)} <script> 🦆\r\n', 5)).toEqual([{ start: 0.5, end: 2, text: 'Été {\\pos(1,2)} <script> 🦆' }]);
	});
	it.each(['1\n00:00:02,000 --> 00:00:01,000\nTexte', '1\n00:00:00,000 --> 00:00:06,000\nTexte', '1\n00:60:00,000 --> 00:61:00,000\nTexte', 'x'.repeat(10001)])('rejects malformed, oversized or out-of-montage SRT', (subtitles) => {
		expect(() => validateStudioEdit({ ...edit(), subtitles })).toThrow();
	});
});

describe('Studio YouTube dubbing validation', () => {
	it.each([
		'https://youtu.be/abcdefghijk?t=3',
		'https://www.youtube.com/watch?v=abcdefghijk&list=ignored',
		'https://m.youtube.com/shorts/abcdefghijk',
		'https://youtube.com/live/abcdefghijk'
	])('normalizes a single video and discards playlist and tracking parameters (%s)', (url) => {
		expect(validateStudioDubbing({ url, offset: -1.25 })).toEqual({ url: 'https://www.youtube.com/watch?v=abcdefghijk', offset: -1.25 });
	});
	it.each([
		undefined, [], {},
		{ url: 'http://www.youtube.com/watch?v=abcdefghijk', offset: 0 },
		{ url: 'https://www.youtube.com.evil.test/watch?v=abcdefghijk', offset: 0 },
		{ url: 'https://user:password@youtube.com/watch?v=abcdefghijk', offset: 0 },
		{ url: 'https://127.0.0.1/watch?v=abcdefghijk', offset: 0 },
		{ url: 'https://www.youtube.com:8080/watch?v=abcdefghijk', offset: 0 },
		{ url: 'https://www.youtube.com/playlist?list=abcdefghijk', offset: 0 },
		{ url: 'https://youtu.be/abcdefghijk/extra', offset: 0 },
		{ url: 'https://youtu.be/abcdefghijk', offset: '0' },
		{ url: 'https://youtu.be/abcdefghijk', offset: NaN },
		{ url: 'https://youtu.be/abcdefghijk', offset: 601 },
		{ url: 'https://youtu.be/abcdefghijk', offset: 0, audioJobId: '../private' }
	])('rejects unsafe links and invalid offsets (%j)', (input) => {
		expect(() => validateStudioDubbing(input)).toThrow();
	});
});

describe('private Studio files and sources', () => {
	it('detects source replacement and rejects source links', async () => {
		const absolute = path.join(root, 'downloads', 'film.mp4');
		await writeFile(absolute, 'source');
		const first = await sourceFingerprint(clip);
		await writeFile(absolute, 'changed source');
		expect((await sourceFingerprint(clip)).fingerprint).not.toBe(first.fingerprint);
		await symlink(absolute, path.join(root, 'downloads', 'link.mp4'));
		await expect(sourceFingerprint({ space: 'downloads', path: 'link.mp4' })).rejects.toMatchObject({ status: 403 });
	});
	it('rejects traversal and symbolic job directories', async () => {
		await expect(studioJobDirectory('../share')).rejects.toMatchObject({ status: 404 });
		await symlink(path.join(root, 'share'), path.join(root, 'studio', jobId));
		await expect(studioJobDirectory(jobId)).rejects.toMatchObject({ status: 403 });
	});
	it('requires ownership before exposing projects or job files', async () => {
		await expect(ownedStudioProject('other', id)).rejects.toMatchObject({ status: 404 });
		await expect(ownedStudioJob('other', id, jobId)).rejects.toMatchObject({ status: 404 });
		expect(mocked.query.mock.calls[0][1]).toEqual([id, 'other']);
		expect(mocked.query.mock.calls[1][1]).toEqual([jobId, id, 'other']);
		expect(await readdir(path.join(root, 'studio'))).toEqual([]);
	});
	it('serves authorized private assets with Range, HEAD and Nginx internal redirects', async () => {
		mocked.query.mockResolvedValue([completed]);
		await writeFile(await studioOutput(jobId, 'export'), '0123456789');
		const url = new URL('http://localhost/api/studio/file?inline=1');
		const response = await studioFile({ url, request: new Request(url, { headers: { range: 'bytes=2-4' } }) } as RequestEvent, 'owner', id, jobId);
		expect(response.status).toBe(206); expect(response.headers.get('content-range')).toBe('bytes 2-4/10'); expect(await response.text()).toBe('234');
		const head = await studioFile({ url, request: new Request(url, { method: 'HEAD' }) } as RequestEvent, 'owner', id, jobId);
		expect(head.headers.get('content-length')).toBe('10'); expect(await head.text()).toBe('');
		vi.stubEnv('FILE_DELIVERY', 'nginx');
		const nginx = await studioFile({ url, request: new Request(url) } as RequestEvent, 'owner', id, jobId);
		expect(nginx.headers.get('x-accel-redirect')).toBe(`/_protected/studio/${jobId}/output.mp4`);
	});
	it('publishes a separate complete copy without replacing a community file', async () => {
		mocked.query.mockImplementation(async (sql: string) => sql.includes('SELECT') ? [completed] : []);
		const output = await studioOutput(jobId, 'export');
		await writeFile(output, 'encoded video');
		expect(await publishStudioJob('owner', id, jobId, { name: 'Été.mp4', confirm: true })).toEqual({ path: 'Été.mp4' });
		expect(await readFile(path.join(root, 'share', 'Été.mp4'), 'utf8')).toBe('encoded video');
		await expect(publishStudioJob('owner', id, jobId, { name: 'Été.mp4', confirm: true })).rejects.toMatchObject({ status: 409 });
		expect(await readdir(path.join(root, 'share'))).toEqual(['Été.mp4']);
		expect(mocked.storage).toHaveBeenCalledWith(13, path.join(root, 'share'));
		await rm(output); expect(await readFile(path.join(root, 'share', 'Été.mp4'), 'utf8')).toBe('encoded video');
	});
	it('serves and publishes a separate dubbed MKV with its matching extension', async () => {
		mocked.query.mockImplementation(async (sql: string) => sql.includes('SELECT') ? [{ ...completed, kind: 'dub' }] : []);
		await writeFile(await studioOutput(jobId, 'dub'), 'dubbed movie');
		const url = new URL('http://localhost/api/studio/file');
		const head = await studioFile({ url, request: new Request(url, { method: 'HEAD' }) } as RequestEvent, 'owner', id, jobId);
		expect(head.headers.get('content-type')).toBe('video/x-matroska');
		expect(head.headers.get('content-disposition')).toContain('output.mkv');
		vi.stubEnv('FILE_DELIVERY', 'nginx');
		const nginx = await studioFile({ url, request: new Request(url) } as RequestEvent, 'owner', id, jobId);
		expect(nginx.headers.get('x-accel-redirect')).toBe(`/_protected/studio/${jobId}/output.mkv`);
		await expect(publishStudioJob('owner', id, jobId, { name: 'Film.mp4', confirm: true })).rejects.toMatchObject({ status: 400 });
		expect(await publishStudioJob('owner', id, jobId, { name: 'Film FR.mkv', confirm: true })).toEqual({ path: 'Film FR.mkv' });
		expect(await readFile(path.join(root, 'share', 'Film FR.mkv'), 'utf8')).toBe('dubbed movie');
		await expect(publishStudioJob('owner', id, jobId, { name: 'Film FR.mkv', confirm: true })).rejects.toMatchObject({ status: 409 });
	});
	it('streams prepared private audio with its MIME type, Range and internal delivery', async () => {
		mocked.query.mockResolvedValue([{ ...completed, kind: 'dub-audio' }]);
		await writeFile(await studioOutput(jobId, 'dub-audio'), '0123456789');
		const url = new URL('http://localhost/api/studio/file?inline=1');
		const response = await studioFile({ url, request: new Request(url, { headers: { range: 'bytes=2-4' } }) } as RequestEvent, 'owner', id, jobId);
		expect(response.status).toBe(206);
		expect(response.headers.get('content-type')).toBe('audio/mp4');
		expect(await response.text()).toBe('234');
		vi.stubEnv('FILE_DELIVERY', 'nginx');
		const nginx = await studioFile({ url, request: new Request(url) } as RequestEvent, 'owner', id, jobId);
		expect(nginx.headers.get('x-accel-redirect')).toBe(`/_protected/studio/${jobId}/output.m4a`);
		await expect(publishStudioJob('owner', id, jobId, { name: 'audio.m4a', confirm: true })).rejects.toMatchObject({ status: 400 });
	});
	it('requires explicit collective publication and completed-output deletion confirmation', async () => {
		await expect(publishStudioJob('owner', id, jobId, { name: 'x.mp4' })).rejects.toMatchObject({ status: 400 });
		mocked.query.mockResolvedValue([completed]);
		await expect(deleteStudioJob('owner', id, jobId, false)).rejects.toMatchObject({ status: 400 });
		expect(mocked.query.mock.calls.some(([sql]) => sql.startsWith('DELETE'))).toBe(false);
	});
	it('does not delete a completed export when cancellation races with completion', async () => {
		mocked.query.mockResolvedValueOnce([{ ...completed, status: 'running' }]).mockResolvedValueOnce([]);
		await expect(deleteStudioJob('owner', id, jobId, false)).rejects.toMatchObject({ status: 409 });
		expect(mocked.query.mock.calls[1][0]).toContain("status IN ('queued','running')");
		expect(mocked.query.mock.calls.some(([sql]) => sql.startsWith('DELETE'))).toBe(false);
	});
	it('snapshots the validated edit and refuses replaced sources before queueing an export', async () => {
		await writeFile(path.join(root, 'downloads', 'film.mp4'), 'original');
		const source = await sourceFingerprint(clip), current = { ...edit(), clips: [{ ...clip, fingerprint: source.fingerprint }] };
		mocked.query.mockResolvedValue([{ id, edit: current, createdAt: new Date(), updatedAt: new Date() }]);
		mocked.clientQuery.mockImplementation(async (sql: string) => ({ rows: sql.includes('count(*)') ? [{ active: 0, total: 0 }] : sql.startsWith('INSERT') ? [{ id: randomUUID(), status: 'queued' }] : [] }));
		await createStudioJob('owner', id, { kind: 'export' });
		const insert = mocked.clientQuery.mock.calls.find(([sql]) => sql.startsWith('INSERT'))!;
		current.clips[0].title = 'Changed after enqueue';
		expect(JSON.parse(insert[1][4]).project.clips[0].title).toBe('Été 🦆');
		await writeFile(path.join(root, 'downloads', 'film.mp4'), 'replacement');
		await expect(createStudioJob('owner', id, { kind: 'export' })).rejects.toMatchObject({ status: 409 });
	});
	it('queues the whole dubbing source independently of montage excerpts and snapshots its version', async () => {
		await writeFile(path.join(root, 'downloads', 'film.mp4'), 'original full movie');
		const source = { space: 'downloads', path: 'film.mp4' } as const;
		const fingerprint = (await sourceFingerprint(source)).fingerprint;
		mocked.query.mockResolvedValue([{ id, edit: { ...edit(), clips: [] }, createdAt: new Date(), updatedAt: new Date() }]);
		mocked.clientQuery.mockImplementation(async (sql: string) => ({ rows: sql.includes('count(*)') ? [{ active: 0, total: 0 }] : sql.startsWith('INSERT') ? [{ id: jobId, kind: 'dub', status: 'queued' }] : [] }));
		await createStudioJob('owner', id, { kind: 'dub', source, dubbing: { url: 'https://youtu.be/abcdefghijk?t=42', offset: 2.5 } });
		const insert = mocked.clientQuery.mock.calls.find(([sql]) => sql.startsWith('INSERT'))!;
		expect(insert[1][3]).toBe('dub');
		expect(JSON.parse(insert[1][4])).toEqual({ project: { ...edit(), clips: [] }, source, fingerprint, dubbing: { url: 'https://www.youtube.com/watch?v=abcdefghijk', offset: 2.5 } });
		mocked.clientQuery.mockClear();
		await expect(createStudioJob('owner', id, { kind: 'dub', source, dubbing: { url: 'https://private.test/', offset: 0 } })).rejects.toMatchObject({ status: 400 });
		expect(mocked.clientQuery).not.toHaveBeenCalled();
	});
	it('queues YouTube audio preparation before any source has been selected', async () => {
		mocked.query.mockResolvedValue([{ id, edit: { ...edit(), clips: [] }, createdAt: new Date(), updatedAt: new Date() }]);
		mocked.clientQuery.mockImplementation(async (sql: string) => ({ rows: sql.includes('count(*)') ? [{ active: 0, total: 0 }] : sql.startsWith('INSERT') ? [{ id: jobId, kind: 'dub-audio', status: 'queued' }] : [] }));
		await createStudioJob('owner', id, { kind: 'dub-audio', dubbing: { url: 'https://youtu.be/abcdefghijk?t=5', offset: 2 } });
		const insert = mocked.clientQuery.mock.calls.find(([sql]) => sql.startsWith('INSERT'))!;
		expect(insert[1][3]).toBe('dub-audio');
		expect(JSON.parse(insert[1][4])).toEqual({ project: { ...edit(), clips: [] }, dubbing: { url: 'https://www.youtube.com/watch?v=abcdefghijk', offset: 0 } });
	});
	it('snapshots owned prepared audio so deleting it cannot break an already queued export', async () => {
		const prepared = { ...completed, kind: 'dub-audio', dubbing: { url: 'https://www.youtube.com/watch?v=abcdefghijk', offset: 0 } };
		mocked.query.mockImplementation(async (sql: string) => sql.includes('FROM studio_projects') ? [{ id, edit: edit(), createdAt: new Date(), updatedAt: new Date() }] : [prepared]);
		mocked.clientQuery.mockImplementation(async (sql: string) => ({ rows: sql.includes('count(*)') ? [{ active: 0, total: 0 }] : sql.startsWith('INSERT') ? [{ id: randomUUID(), kind: 'dub', status: 'queued' }] : [] }));
		await writeFile(path.join(root, 'downloads', 'film.mp4'), 'movie');
		await writeFile(await studioOutput(jobId, 'dub-audio'), 'prepared French audio');
		await createStudioJob('owner', id, { kind: 'dub', source: clip, dubbing: { url: 'https://youtu.be/abcdefghijk', offset: -0.125, audioJobId: jobId } });
		const insert = mocked.clientQuery.mock.calls.find(([sql]) => sql.startsWith('INSERT'))!;
		expect(JSON.parse(insert[1][4]).dubbing).toEqual({ ...prepared.dubbing, offset: -0.125, audioJobId: jobId });
		await deleteStudioJob('owner', id, jobId, true);
		expect(await readFile(path.join(root, 'studio', insert[1][0], 'audio.m4a'), 'utf8')).toBe('prepared French audio');
		expect(mocked.query.mock.calls.find(([sql]) => sql.includes('FROM studio_jobs'))?.[1]).toEqual([jobId, id, 'owner']);
	});
	it.each([
		{ kind: 'export' }, { status: 'running' }, { dubbing: { url: 'https://www.youtube.com/watch?v=other_video' } }
	])('rejects a cached soundtrack of the wrong kind, state or URL (%j)', async (changes) => {
		mocked.query.mockImplementation(async (sql: string) => sql.includes('FROM studio_projects') ? [{ id, edit: edit(), createdAt: new Date(), updatedAt: new Date() }] : [{ ...completed, kind: 'dub-audio', dubbing: { url: 'https://www.youtube.com/watch?v=abcdefghijk', offset: 0 }, ...changes }]);
		await writeFile(path.join(root, 'downloads', 'film.mp4'), 'movie');
		await expect(createStudioJob('owner', id, { kind: 'dub', source: clip, dubbing: { url: 'https://youtu.be/abcdefghijk', offset: 0, audioJobId: jobId } })).rejects.toMatchObject({ status: 400 });
		expect(mocked.clientQuery).not.toHaveBeenCalled();
	});
	it('rejects unavailable and symlinked prepared audio without queueing an export', async () => {
		const prepared = { ...completed, kind: 'dub-audio', dubbing: { url: 'https://www.youtube.com/watch?v=abcdefghijk', offset: 0 } };
		mocked.query.mockImplementation(async (sql: string) => sql.includes('FROM studio_projects') ? [{ id, edit: edit(), createdAt: new Date(), updatedAt: new Date() }] : [prepared]);
		await writeFile(path.join(root, 'downloads', 'film.mp4'), 'movie');
		const input = { kind: 'dub', source: clip, dubbing: { url: 'https://youtu.be/abcdefghijk', offset: 0, audioJobId: jobId } };
		await expect(createStudioJob('owner', id, input)).rejects.toMatchObject({ status: 404 });
		await symlink(path.join(root, 'downloads', 'film.mp4'), await studioOutput(jobId, 'dub-audio'));
		await expect(createStudioJob('owner', id, input)).rejects.toMatchObject({ status: 403 });
		mocked.query.mockImplementation(async (sql: string) => sql.includes('FROM studio_projects') ? [{ id, edit: edit(), createdAt: new Date(), updatedAt: new Date() }] : []);
		await expect(createStudioJob('owner', id, input)).rejects.toMatchObject({ status: 404 });
		expect(mocked.clientQuery).not.toHaveBeenCalled();
		expect(await readdir(path.join(root, 'studio'))).toEqual([jobId]);
	});
});
