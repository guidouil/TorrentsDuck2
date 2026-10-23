import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RequestEvent } from '@sveltejs/kit';
import { relativePath, resolveFile, listFiles, changeFiles, downloadFile, uploadFile, byteRange, moveWithoutReplacement } from '../src/lib/server/files';

let directory: string;
beforeEach(async () => {
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
	return { request, url: new URL(url) } as RequestEvent;
}

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
	it('keeps downloads immutable and root undeletable', async () => {
		await expect(changeFiles({ space: 'downloads', action: 'delete', path: 'movie.mp4', confirm: true })).rejects.toMatchObject({ status: 403 });
		await expect(changeFiles({ space: 'share', action: 'delete', path: '', confirm: true })).rejects.toMatchObject({ status: 400 });
		await expect(changeFiles({ space: 'share', action: 'delete', path: 'anything' })).rejects.toMatchObject({ status: 404 });
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
