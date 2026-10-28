import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';
import type { PoolClient } from 'pg';
const mocked = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock('../src/lib/server/db', () => ({ db: { connect: mocked.connect }, query: vi.fn(), transaction: vi.fn() }));
import { runStudioProcess, runStudioWorker, studioAss, studioDimensions, studioJobAllowed, studioMetadata, studioVideoFilter, validateStudioOutput } from '../src/lib/server/studio-worker';
import type { StudioClip } from '../src/lib/studio';

const clip: StudioClip = { space: 'share', path: 'movie.mkv', fingerprint: 'a'.repeat(64), start: 2, end: 4, audio: 1, title: '', x: 0.75, y: 0.25 };

describe('Studio media metadata', () => {
	it('ignores album art, applies rotation and retains selectable audio stream indexes', () => {
		expect(studioMetadata(clip, clip.fingerprint, {
			format: { duration: '125.5' }, streams: [
				{ index: 0, codec_type: 'video', width: 200, height: 200, disposition: { attached_pic: 1 } },
				{ index: 1, codec_type: 'audio', tags: { language: 'fra', title: 'Original' } },
				{ index: 2, codec_type: 'video', width: 1920, height: 1080, side_data_list: [{ rotation: -90 }] },
				{ index: 3, codec_type: 'audio' }
			]
		})).toMatchObject({ duration: 125.5, width: 1080, height: 1920, videoIndex: 2, audio: [{ index: 1, label: 'fra · Original' }, { index: 3, label: 'Audio 3' }] });
	});
	it.each([
		{}, { streams: [] },
		{ format: { duration: 'NaN' }, streams: [{ index: 0, codec_type: 'video', width: 100, height: 100 }] },
		{ format: { duration: '1' }, streams: [{ index: 0, codec_type: 'video', width: 20000, height: 100 }] }
	])('rejects missing video and unbounded media metadata', (data) => {
		expect(() => studioMetadata(clip, clip.fingerprint, data)).toThrow();
	});
});

describe('Studio deterministic rendering', () => {
	const output = { format: { duration: '2.022' }, streams: [{ codec_type: 'video', codec_name: 'h264', width: 1080, height: 1920 }, { codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 2 }] };
	it('validates complete output streams and tolerates codec padding within a few frames', () => {
		expect(() => validateStudioOutput(output, 1080, 1920, 2)).not.toThrow();
	});
	it.each([
		{ format: { duration: '2' }, streams: [] },
		{ ...output, format: { duration: '0' } },
		{ ...output, format: { duration: '1' } },
		{ ...output, format: { duration: '3' } },
		{ ...output, streams: output.streams.slice(0, 1) }
	])('rejects incomplete, truncated and overlong files before publication (%s)', (data) => {
		expect(() => validateStudioOutput(data, 1080, 1920, 2)).toThrow('Rendu incomplet');
	});
	it('uses bounded landscape and portrait dimensions for export and preview', () => {
		expect(studioDimensions('16:9', false)).toEqual([1920, 1080]);
		expect(studioDimensions('9:16', false)).toEqual([1080, 1920]);
		expect(studioDimensions('16:9', true)).toEqual([640, 360]);
		expect(studioDimensions('9:16', true)).toEqual([360, 640]);
	});
	it('keeps user text out of filter expressions and uses safe generated text files', () => {
		const filter = studioVideoFilter({ ...clip, title: "':movie=/etc/passwd" }, 1080, 1920, 'title-0.txt', 'captions-0.ass');
		expect(filter).toContain("x='(iw-ow)*0.75'");
		expect(filter).toContain("y='(ih-oh)*0.25'");
		expect(filter).toContain('scale=1080:1920');
		expect(filter).toContain('textfile=title-0.txt:expansion=none');
		expect(filter).not.toContain('/etc/passwd');
	});
	it('clips final timeline captions to each segment and escapes ASS commands as plain text', () => {
		const ass = studioAss([
			{ start: 1, end: 3, text: '{\\p1}hello\nsecond line' },
			{ start: 4, end: 8, text: 'Later' },
			{ start: 20, end: 21, text: 'Outside' }
		], 1080, 1920, 2, 3);
		expect(ass).toContain('0:00:00.00,0:00:01.00,Default,,0,0,0,,｛＼p1｝hello\\Nsecond line');
		expect(ass).toContain('0:00:02.00,0:00:03.00,Default,,0,0,0,,Later');
		expect(ass).not.toContain('Outside');
		expect(ass).not.toContain('{\\p1}');
	});
});

describe('Studio subprocess isolation', () => {
	it('captures bounded metadata without a shell', async () => {
		expect(await runStudioProcess(process.execPath, ['-e', 'process.stdout.write(JSON.stringify({duration:2}))'], { signal: new AbortController().signal, capture: true })).toBe('{"duration":2}');
	});
	it('rejects excess metadata and nonzero exit status', async () => {
		await expect(runStudioProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(600000));setTimeout(()=>{},1000)'], { signal: new AbortController().signal, capture: true })).rejects.toThrow('volumineuses');
		await expect(runStudioProcess(process.execPath, ['-e', 'process.exit(2)'], { signal: new AbortController().signal })).rejects.toThrow('impossible');
	});
	it('terminates an active process when cancelled and rejects pre-cancelled work', async () => {
		const controller = new AbortController();
		const running = runStudioProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { signal: controller.signal });
		setTimeout(() => controller.abort(new Error('Annulation demandée.')), 50);
		await expect(running).rejects.toThrow('Annulation demandée');
		await expect(runStudioProcess(process.execPath, ['-e', 'process.exit(0)'], { signal: controller.signal })).rejects.toThrow('Annulation demandée');
	});
	it('stops hung work after its timeout', async () => {
		await expect(runStudioProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { signal: new AbortController().signal, timeout: 50 })).rejects.toThrow('Délai');
	});
	it.each([
		undefined,
		{ cancel_requested: true, enabled: true, approved: true },
		{ cancel_requested: false, enabled: false, approved: true },
		{ cancel_requested: false, enabled: true, approved: false }
	])('stops revoked, cancelled and deleted jobs (%s)', (row) => {
		expect(studioJobAllowed(row)).toBe(false);
	});
	it('allows an approved active owner to keep rendering', () => {
		expect(studioJobAllowed({ cancel_requested: false, enabled: true, approved: true })).toBe(true);
	});
});

describe('Studio durable worker lifecycle', () => {
	it('keeps actionable file/storage errors and cleans failed job files', async () => {
		const root = await mkdtemp(path.join(tmpdir(), 'duck-studio-failure-'));
		await mkdir(path.join(root, 'share'));
		await mkdir(path.join(root, 'studio'));
		vi.stubEnv('STUDIO_DIR', path.join(root, 'studio'));
		vi.stubEnv('SHARE_DIR', path.join(root, 'share'));
		const id = '22222222-2222-4222-8222-222222222222';
		const controller = new AbortController();
		const query = vi.fn().mockImplementation(async (sql: string) => {
			if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }], rowCount: 1 };
			if (sql.includes('RETURNING id,user_id,project_id,kind,input')) return { rows: [{ id, project_id: id, user_id: 'fixture', kind: 'probe', input: { source: { space: 'share', path: 'missing.mp4' }, fingerprint: 'a'.repeat(64), project: {} } }], rowCount: 1 };
			if (sql.startsWith('SELECT j.cancel_requested')) return { rows: [{ cancel_requested: false, enabled: true, approved: true }], rowCount: 1 };
			if (sql.includes('status=$2,error=$3')) controller.abort();
			if (sql.startsWith('SELECT id FROM studio_jobs')) return { rows: [{ id }], rowCount: 1 };
			return { rows: [], rowCount: 0 };
		});
		mocked.connect.mockResolvedValue(Object.assign(new EventEmitter(), { query, release: vi.fn() }));
		try {
			await runStudioWorker(controller.signal);
			expect(query.mock.calls.find(([sql]) => sql.includes('status=$2,error=$3'))?.[1]).toEqual([id, 'failed', 'Fichier introuvable.']);
			await expect(readFile(path.join(root, 'studio', id, 'output.mp4'))).rejects.toMatchObject({ code: 'ENOENT' });
		} finally { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
	});
	it('stops and destroys its dedicated lock connection on PostgreSQL disconnect', async () => {
		const root = await mkdtemp(path.join(tmpdir(), 'duck-studio-disconnect-'));
		vi.stubEnv('STUDIO_DIR', root);
		const client = Object.assign(new EventEmitter(), { query: vi.fn(), release: vi.fn() });
		client.query.mockImplementation(async (sql: string) => {
			if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }], rowCount: 1 };
			if (sql.includes('RETURNING id,user_id,project_id,kind,input')) client.emit('error', new Error('connection lost'));
			return { rows: [], rowCount: 0 };
		});
		mocked.connect.mockResolvedValue(client);
		try {
			await expect(runStudioWorker(new AbortController().signal)).rejects.toThrow('Connexion du moteur interrompue');
			expect(client.release).toHaveBeenCalledWith(true);
			expect(client.query.mock.calls.some(([sql]) => sql.includes('pg_advisory_unlock'))).toBe(false);
		} finally { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
	});
	it('takes the single-worker lock and refuses another active renderer', async () => {
		const query = vi.fn().mockResolvedValue({ rows: [{ locked: false }], rowCount: 1 });
		const release = vi.fn();
		const client = Object.assign(new EventEmitter(), { query, release });
		mocked.connect.mockResolvedValue(client);
		await expect(runStudioWorker(new AbortController().signal)).rejects.toThrow('déjà actif');
		expect(query).toHaveBeenCalledExactlyOnceWith('SELECT pg_try_advisory_lock($1) AS locked', [782413]);
		expect(release).toHaveBeenCalled();
	});
	it('marks interrupted work failed, cleans partial files and preserves queued work before shutdown', async () => {
		const root = await mkdtemp(path.join(tmpdir(), 'duck-studio-worker-'));
		const id = '11111111-1111-4111-8111-111111111111';
		const directory = path.join(root, id);
		await mkdir(directory);
		await writeFile(path.join(directory, 'render.partial.mp4'), 'partial fixture');
		vi.stubEnv('STUDIO_DIR', root);
		const controller = new AbortController();
		const query = vi.fn().mockImplementation(async (sql: string) => {
			if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }], rowCount: 1 };
			if (sql.includes("error='Rendu interrompu")) return { rows: [{ id }], rowCount: 1 };
			if (sql.startsWith('SELECT id FROM studio_jobs')) return { rows: [{ id }], rowCount: 1 };
			if (sql.includes('RETURNING id,user_id,project_id,kind,input')) { controller.abort(); return { rows: [], rowCount: 0 }; }
			return { rows: [], rowCount: 0 };
		});
		const release = vi.fn();
		mocked.connect.mockResolvedValue(Object.assign(new EventEmitter(), { query, release }) as unknown as PoolClient);
		try {
			await runStudioWorker(controller.signal);
			await expect(readFile(path.join(directory, 'render.partial.mp4'))).rejects.toMatchObject({ code: 'ENOENT' });
			expect(query.mock.calls.some(([sql]) => sql.includes("WHERE status='running' RETURNING id"))).toBe(true);
			expect(query.mock.calls.some(([sql]) => sql.includes("WHERE status='queued' ORDER BY created_at,id LIMIT 1"))).toBe(true);
			expect(query).toHaveBeenLastCalledWith('SELECT pg_advisory_unlock($1)', [782413]);
			expect(release).toHaveBeenCalledWith(false);
		} finally { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
	});
});
