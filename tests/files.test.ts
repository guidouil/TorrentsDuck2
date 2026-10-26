import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, readdir, utimes } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RequestEvent } from '@sveltejs/kit';
import { relativePath, resolveFile, listFiles, changeFiles, downloadFile, uploadFile, byteRange, moveWithoutReplacement } from '../src/lib/server/files';
import { POST } from '../src/routes/api/files/+server';

const mocks = vi.hoisted(() => ({ member: vi.fn(), audit: vi.fn() }));
vi.mock('../src/lib/server/permissions', () => ({ requireMember: mocks.member }));
vi.mock('../src/lib/server/audit', () => ({ audit: mocks.audit }));

let directory: string;
beforeEach(async () => {
	vi.resetAllMocks();
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

function event(url: string, options: RequestInit = {}) {
	const request = new Request(url, options);
	return { request, url: new URL(url) } as RequestEvent<Record<string, never>, '/api/files'>;
}

describe('download deletion API', () => {
	it.each(['admin', 'member'])('checks the authenticated %s role instead of the request body', async (role) => {
		mocks.member.mockResolvedValue({ id: role, role });
		const request = event('http://localhost/api/files', {
			method: 'POST', headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ space: 'downloads', action: 'delete', path: 'movie.mp4', confirm: true, role: 'admin' })
		});
		if (role === 'admin') {
			expect((await POST(request)).status).toBe(200);
			expect(await readdir(process.env.DOWNLOADS_DIR!)).toEqual([]);
		} else {
			await expect(POST(request)).rejects.toMatchObject({ status: 403 });
			expect(await readFile(path.join(process.env.DOWNLOADS_DIR!, 'movie.mp4'), 'utf8')).toBe('0123456789');
		}
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
		['', ['z-new.txt', 'a-old.txt']],
		['sort=modifiedAt', ['z-new.txt', 'a-old.txt']],
		['sort=modifiedAt&order=asc', ['a-old.txt', 'z-new.txt']],
		['sort=name', ['a-old.txt', 'z-new.txt']],
		['sort=name&order=desc', ['z-new.txt', 'a-old.txt']],
		['sort=size', ['a-old.txt', 'z-new.txt']]
	])('sorts files with %s and keeps folders first', async (options, expected) => {
		const root = process.env.SHARE_DIR!;
		await mkdir(path.join(root, 'folder'));
		await writeFile(path.join(root, 'a-old.txt'), 'old');
		await writeFile(path.join(root, 'z-new.txt'), 'new content');
		for (const [name, date] of [['folder', '2024-01-01'], ['a-old.txt', '2025-01-01'], ['z-new.txt', '2026-01-01']]) {
			await utimes(path.join(root, name), new Date(date), new Date(date));
		}
		const list = await listFiles('share', '', new URLSearchParams(options));
		expect(list.entries.map((entry) => entry.name)).toEqual(['folder', ...expected]);
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
	it('keeps downloads read-only for members and root undeletable', async () => {
		await expect(changeFiles({ space: 'downloads', action: 'delete', path: 'movie.mp4', confirm: true })).rejects.toMatchObject({ status: 403 });
		await expect(changeFiles({ space: 'downloads', action: 'delete', path: 'movie.mp4', confirm: true, role: 'admin' })).rejects.toMatchObject({ status: 403 });
		await expect(changeFiles({ space: 'share', action: 'delete', path: '', confirm: true })).rejects.toMatchObject({ status: 400 });
		await expect(changeFiles({ space: 'share', action: 'delete', path: 'anything' })).rejects.toMatchObject({ status: 404 });
	});
	it('allows administrators to delete downloads and folders only with confirmation', async () => {
		await expect(changeFiles({ space: 'downloads', action: 'delete', path: 'movie.mp4' }, 'admin')).rejects.toMatchObject({ status: 400 });
		await expect(changeFiles({ space: 'downloads', action: 'delete', path: '', confirm: true }, 'admin')).rejects.toMatchObject({ status: 400 });
		await changeFiles({ space: 'downloads', action: 'delete', path: 'movie.mp4', confirm: true }, 'admin');
		await mkdir(path.join(process.env.DOWNLOADS_DIR!, 'folder'));
		await writeFile(path.join(process.env.DOWNLOADS_DIR!, 'folder', 'file.txt'), 'collective');
		await changeFiles({ space: 'downloads', action: 'delete', path: 'folder', confirm: true }, 'admin');
		expect(await readdir(process.env.DOWNLOADS_DIR!)).toEqual([]);
	});
	it.each(['mkdir', 'rename'])('rejects administrator %s in downloads', async (action) => {
		await expect(changeFiles({ space: 'downloads', action, path: 'movie.mp4', name: 'other' }, 'admin')).rejects.toMatchObject({ status: 403 });
		expect(await readFile(path.join(process.env.DOWNLOADS_DIR!, 'movie.mp4'), 'utf8')).toBe('0123456789');
	});
	it('rejects unsafe paths and symbolic links during administrator deletion', async () => {
		await symlink(process.env.SHARE_DIR!, path.join(process.env.DOWNLOADS_DIR!, 'escape'));
		await expect(changeFiles({ space: 'downloads', action: 'delete', path: '../share', confirm: true }, 'admin')).rejects.toMatchObject({ status: 400 });
		await expect(changeFiles({ space: 'downloads', action: 'delete', path: 'escape', confirm: true }, 'admin')).rejects.toMatchObject({ status: 403 });
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
