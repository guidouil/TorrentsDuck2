import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, readdir, utimes, lstat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RequestEvent } from '@sveltejs/kit';
import { relativePath, resolveFile, listFiles, listStreamingFiles, changeFiles, downloadFile, uploadFile, byteRange, moveWithoutReplacement } from '../src/lib/server/files';
import { POST } from '../src/routes/api/files/+server';
import { GET as streaming } from '../src/routes/api/files/streaming/+server';

const mocks = vi.hoisted(() => ({ member: vi.fn(), audit: vi.fn(), statfs: vi.fn() }));
vi.mock('node:fs/promises', async (original) => ({ ...await original<typeof import('node:fs/promises')>(), statfs: mocks.statfs }));
vi.mock('../src/lib/server/permissions', () => ({ requireMember: mocks.member }));
vi.mock('../src/lib/server/audit', () => ({ audit: mocks.audit }));

let directory: string;
beforeEach(async () => {
	vi.resetAllMocks();
	mocks.statfs.mockResolvedValue({ blocks: 1000, bsize: 1024, bfree: 800, bavail: 800 });
	directory = await mkdtemp(path.join(os.tmpdir(), 'duck-files-'));
	process.env.DATA_ROOT = directory;
	process.env.DOWNLOADS_DIR = path.join(directory, 'downloads');
	process.env.SHARE_DIR = path.join(directory, 'share');
	process.env.FILE_DELIVERY = '';
	await mkdir(process.env.DOWNLOADS_DIR);
	await mkdir(process.env.SHARE_DIR);
	await writeFile(path.join(process.env.DOWNLOADS_DIR, 'movie.mp4'), '0123456789');
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

function event<Route extends '/api/files' | '/api/files/streaming' = '/api/files'>(url: string, options: RequestInit = {}) {
	const request = new Request(url, options);
	return { request, url: new URL(url) } as RequestEvent<Record<string, never>, Route>;
}

describe('download deletion API', () => {
	it.each(['admin', 'member'])('allows an authenticated %s to delete files and nonempty folders', async (role) => {
		mocks.member.mockResolvedValue({ id: role, role });
		await mkdir(path.join(process.env.DOWNLOADS_DIR!, 'folder', 'nested'), { recursive: true });
		await writeFile(path.join(process.env.DOWNLOADS_DIR!, 'folder', 'nested', 'file.txt'), 'collective');
		for (const target of ['movie.mp4', 'folder']) {
			const request = event('http://localhost/api/files', {
				method: 'POST', headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ space: 'downloads', action: 'delete', path: target, confirm: true })
			});
			expect((await POST(request)).status).toBe(200);
			expect(mocks.audit).toHaveBeenCalledWith(role, 'file.delete.requested', { space: 'downloads', path: target });
		}
		expect(await readdir(process.env.DOWNLOADS_DIR!)).toEqual([]);
	});
	it.each([undefined, false, 'true'])('requires explicit confirmation from a member (%s)', async (confirm) => {
		mocks.member.mockResolvedValue({ id: 'member', role: 'member' });
		await expect(POST(event('http://localhost/api/files', {
			method: 'POST', headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ space: 'downloads', action: 'delete', path: 'movie.mp4', confirm })
		}))).rejects.toMatchObject({ status: 400 });
		expect(await readFile(path.join(process.env.DOWNLOADS_DIR!, 'movie.mp4'), 'utf8')).toBe('0123456789');
	});
	it.each([401, 403])('rejects access denied by the membership guard (%s) before deleting', async (status) => {
		mocks.member.mockRejectedValue({ status });
		await expect(POST(event('http://localhost/api/files', {
			method: 'POST', headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ space: 'downloads', action: 'delete', path: 'movie.mp4', confirm: true })
		}))).rejects.toMatchObject({ status });
		expect(await readFile(path.join(process.env.DOWNLOADS_DIR!, 'movie.mp4'), 'utf8')).toBe('0123456789');
		expect(mocks.audit).not.toHaveBeenCalled();
	});
});

describe('file listing order', () => {
	it.each([
		['', ['z-new.txt', 'm-folder', 'a-old.txt']],
		['sort=modifiedAt', ['z-new.txt', 'm-folder', 'a-old.txt']],
		['sort=modifiedAt&order=asc', ['a-old.txt', 'm-folder', 'z-new.txt']],
		['sort=name', ['a-old.txt', 'm-folder', 'z-new.txt']],
		['sort=name&order=desc', ['z-new.txt', 'm-folder', 'a-old.txt']]
	])('sorts files and folders together with %s', async (options, expected) => {
		const root = process.env.SHARE_DIR!;
		await mkdir(path.join(root, 'm-folder'));
		await writeFile(path.join(root, 'a-old.txt'), 'old');
		await writeFile(path.join(root, 'z-new.txt'), 'new content');
		for (const [name, date] of [['m-folder', '2025-06-01'], ['a-old.txt', '2025-01-01'], ['z-new.txt', '2026-01-01']]) {
			await utimes(path.join(root, name), new Date(date), new Date(date));
		}
		const list = await listFiles('share', '', new URLSearchParams(options));
		expect(list.entries.map((entry) => entry.name)).toEqual(expected);
	});
	it('breaks identical date ties by name regardless of entry type', async () => {
		const root = process.env.SHARE_DIR!;
		await mkdir(path.join(root, 'z-folder'));
		await writeFile(path.join(root, 'a-file'), 'file');
		for (const name of ['z-folder', 'a-file']) await utimes(path.join(root, name), new Date('2025-01-01'), new Date('2025-01-01'));
		expect((await listFiles('share', '', new URLSearchParams('sort=modifiedAt'))).entries.map((entry) => entry.name)).toEqual(['a-file', 'z-folder']);
	});
	it('returns all entries beyond the paginated limit when explicitly requested', async () => {
		await Promise.all(Array.from({ length: 505 }, (_, index) => writeFile(path.join(process.env.SHARE_DIR!, `${index}.txt`), 'file')));
		const all = await listFiles('share', '', new URLSearchParams('all=1&offset=500&limit=1'));
		expect(all.entries).toHaveLength(505);
		expect(all).toMatchObject({ total: 505, offset: 0, limit: 505 });
		const page = await listFiles('share', '', new URLSearchParams('offset=500&limit=1'));
		expect(page.entries).toHaveLength(1);
		expect(page).toMatchObject({ total: 505, offset: 500, limit: 1 });
	});
});

describe('streaming catalogue', () => {
	it('includes nested videos, searches their paths and excludes links, empty and temporary files', async () => {
		const root = process.env.SHARE_DIR!;
		await mkdir(path.join(root, 'Films'));
		for (const name of ['Films/Été.MKV', 'Films/music.mp3', 'notes.txt', '.duck-upload-pending.mp4', 'unfinished.mkv.!qB']) await writeFile(path.join(root, name), 'content');
		await writeFile(path.join(root, 'empty.mp4'), '');
		await symlink(process.env.DOWNLOADS_DIR!, path.join(root, 'escape'));
		await symlink(path.join(process.env.DOWNLOADS_DIR!, 'movie.mp4'), path.join(root, 'linked.mp4'));
		const result = await listStreamingFiles('share');
		expect(result.total).toBe(1);
		expect(result.entries[0]).toMatchObject({ name: 'Été.MKV', path: 'Films/Été.MKV', directory: false, size: 7 });
		expect((await listStreamingFiles('share', 'fILMs/éTé')).total).toBe(1);
		expect((await listStreamingFiles('share', 'absent')).total).toBe(0);
	});
	it('sorts by filesystem creation dates independently of modification dates', async () => {
		const root = process.env.SHARE_DIR!;
		await writeFile(path.join(root, 'z-first.mkv'), 'first');
		await writeFile(path.join(root, 'a-second.mp4'), 'second');
		await utimes(path.join(root, 'z-first.mkv'), new Date('2031-01-01'), new Date('2031-01-01'));
		await utimes(path.join(root, 'a-second.mp4'), new Date('2030-01-01'), new Date('2030-01-01'));
		const expected = await Promise.all(['z-first.mkv', 'a-second.mp4'].map(async (name) => {
			const stat = await lstat(path.join(root, name));
			return { name, addedAt: (stat.birthtimeMs > 0 ? stat.birthtime : stat.ctime).toISOString() };
		}));
		expected.sort((a, b) => b.addedAt.localeCompare(a.addedAt) || a.name.localeCompare(b.name));
		const result = await listStreamingFiles('share');
		expect(result.entries.map(({ name, addedAt }) => ({ name, addedAt }))).toEqual(expected);
		expect(result.entries.every((entry) => entry.addedAt !== entry.modifiedAt)).toBe(true);
	});
	it.each([401, 403])('checks membership before scanning files (%s)', async (status) => {
		mocks.member.mockRejectedValue({ status });
		await expect(streaming(event<'/api/files/streaming'>('http://localhost/api/files/streaming'))).rejects.toMatchObject({ status });
	});
	it('serves only the requested valid space with private cache headers', async () => {
		mocks.member.mockResolvedValue({ id: 'catalogue-member', role: 'member' });
		const response = await streaming(event<'/api/files/streaming'>('http://localhost/api/files/streaming?space=downloads&search=movie'));
		expect(response.headers.get('cache-control')).toBe('private, no-store');
		expect(await response.json()).toMatchObject({ total: 1, entries: [{ path: 'movie.mp4' }] });
		await expect(streaming(event<'/api/files/streaming'>('http://localhost/api/files/streaming?space=invalid'))).rejects.toMatchObject({ status: 400 });
	});
	it('fails explicitly rather than silently truncating a scan that exceeds its deadline', async () => {
		const now = vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(31_000);
		try { await expect(listStreamingFiles('downloads')).rejects.toMatchObject({ status: 413 }); }
		finally { now.mockRestore(); }
	});
});

describe('file boundary', () => {
	it.each(['../etc/passwd', '/etc/passwd', 'a/../secret', 'a/./b', 'a\\b', 'a\0b', 'a\nb'])('rejects %s', (value) => {
		expect(() => relativePath(value)).toThrow();
	});
	it('rejects symbolic links at each component', async () => {
		await symlink(directory, path.join(process.env.SHARE_DIR!, 'escape'));
		await expect(resolveFile('share', 'escape/downloads/movie.mp4')).rejects.toMatchObject({ status: 403 });
		const list = await listFiles('share', '', new URLSearchParams());
		expect(list.entries).toEqual([]);
	});
	it.each(['share', 'downloads'])('keeps the %s root undeletable', async (space) => {
		await expect(changeFiles({ space, action: 'delete', path: '', confirm: true })).rejects.toMatchObject({ status: 400 });
		await expect(changeFiles({ space: 'share', action: 'delete', path: 'anything' })).rejects.toMatchObject({ status: 404 });
	});
	it('allows deletion of downloads and folders only with confirmation', async () => {
		await expect(changeFiles({ space: 'downloads', action: 'delete', path: 'movie.mp4' })).rejects.toMatchObject({ status: 400 });
		await changeFiles({ space: 'downloads', action: 'delete', path: 'movie.mp4', confirm: true });
		await mkdir(path.join(process.env.DOWNLOADS_DIR!, 'folder'));
		await writeFile(path.join(process.env.DOWNLOADS_DIR!, 'folder', 'file.txt'), 'collective');
		await changeFiles({ space: 'downloads', action: 'delete', path: 'folder', confirm: true });
		expect(await readdir(process.env.DOWNLOADS_DIR!)).toEqual([]);
	});
	it.each(['mkdir', 'rename'])('rejects %s in downloads', async (action) => {
		await expect(changeFiles({ space: 'downloads', action, path: 'movie.mp4', name: 'other' })).rejects.toMatchObject({ status: 403 });
		expect(await readFile(path.join(process.env.DOWNLOADS_DIR!, 'movie.mp4'), 'utf8')).toBe('0123456789');
	});
	it('rejects unsafe paths and symbolic links during deletion', async () => {
		await symlink(process.env.SHARE_DIR!, path.join(process.env.DOWNLOADS_DIR!, 'escape'));
		await expect(changeFiles({ space: 'downloads', action: 'delete', path: '../share', confirm: true })).rejects.toMatchObject({ status: 400 });
		await expect(changeFiles({ space: 'downloads', action: 'delete', path: 'escape', confirm: true })).rejects.toMatchObject({ status: 403 });
		expect(await readdir(process.env.SHARE_DIR!)).toEqual([]);
	});
	it('rejects uploads in downloads', async () => {
		const form = new FormData();
		form.set('file', new File(['forbidden'], 'upload.txt'));
		await expect(uploadFile(event('http://localhost/api/files?space=downloads', { method: 'POST', body: form }))).rejects.toMatchObject({ status: 403 });
	});
	it('requires destructive confirmation and refuses rename collisions', async () => {
		await writeFile(path.join(process.env.SHARE_DIR!, 'one'), 'original');
		await writeFile(path.join(process.env.SHARE_DIR!, 'two'), 'keep');
		await expect(changeFiles({ space: 'share', action: 'delete', path: 'one' })).rejects.toMatchObject({ status: 400 });
		await expect(changeFiles({ space: 'share', action: 'rename', path: 'one', name: 'two' })).rejects.toMatchObject({ status: 409 });
		await expect(moveWithoutReplacement(path.join(process.env.SHARE_DIR!, 'one'), path.join(process.env.SHARE_DIR!, 'two'))).rejects.toMatchObject({ status: 409 });
		expect(await readFile(path.join(process.env.SHARE_DIR!, 'two'), 'utf8')).toBe('keep');
		await changeFiles({ space: 'share', action: 'rename', path: 'one', name: 'renamed' });
		expect(await readFile(path.join(process.env.SHARE_DIR!, 'renamed'), 'utf8')).toBe('original');
	});
	it('uploads a multipart file atomically and preserves an existing file', async () => {
		const form = new FormData();
		form.set('file', new File(['complete content'], 'upload.txt'));
		await uploadFile(event('http://localhost/api/files?space=share', { method: 'POST', body: form }));
		expect(await readFile(path.join(process.env.SHARE_DIR!, 'upload.txt'), 'utf8')).toBe('complete content');
		const overwrite = new FormData();
		overwrite.set('file', new File(['must not replace'], 'upload.txt'));
		await expect(uploadFile(event('http://localhost/api/files?space=share', { method: 'POST', body: overwrite }))).rejects.toMatchObject({ status: 409 });
		expect(await readFile(path.join(process.env.SHARE_DIR!, 'upload.txt'), 'utf8')).toBe('complete content');
		expect((await readdir(process.env.SHARE_DIR!)).filter((name) => name.startsWith('.duck-upload-'))).toEqual([]);
	});
	it('rejects multipart metadata that disagrees with validated destination', async () => {
		const form = new FormData();
		form.set('space', 'downloads');
		form.set('file', new File(['evil'], 'bad.txt'));
		await expect(uploadFile(event('http://localhost/api/files?space=share', { method: 'POST', body: form }))).rejects.toThrow();
		expect(await readdir(process.env.SHARE_DIR!)).toEqual([]);
	});
});

describe('protected media', () => {
	it('supports seek, suffix ranges and HEAD', async () => {
		const response = await downloadFile(event('http://localhost', { headers: { range: 'bytes=3-5' } }), 'downloads', 'movie.mp4', true);
		expect(response.status).toBe(206);
		expect(response.headers.get('content-range')).toBe('bytes 3-5/10');
		expect(await response.text()).toBe('345');
		expect(byteRange('bytes=-4', 10)).toEqual({ start: 6, end: 9 });
		const head = await downloadFile(event('http://localhost', { method: 'HEAD' }), 'downloads', 'movie.mp4');
		expect(head.body).toBeNull();
		expect(head.headers.get('content-length')).toBe('10');
	});
	it.each(['bytes=20-', 'bytes=4-2', 'bytes=-0', 'bytes=0-1,4-5', 'invalid'])('rejects unsatisfiable range %s', (range) => {
		expect(() => byteRange(range, 10)).toThrow();
	});
	it('delegates only a checked path to the Nginx internal location', async () => {
		process.env.FILE_DELIVERY = 'nginx';
		const response = await downloadFile(event('http://localhost'), 'downloads', 'movie.mp4');
		expect(response.body).toBeNull();
		expect(response.headers.get('x-accel-redirect')).toBe('/_protected/downloads/movie.mp4');
	});
});
