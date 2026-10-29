import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RequestEvent } from '@sveltejs/kit';
import { GET as audio } from '../src/routes/api/files/audio/+server';
import { GET as download, HEAD } from '../src/routes/api/files/download/+server';

const mocks = vi.hoisted(() => ({ member: vi.fn() }));
vi.mock('../src/lib/server/permissions', () => ({ requireMember: mocks.member }));

function element(id: string, content: Buffer | string | number) {
	const data = typeof content === 'number' ? Buffer.of(content) : Buffer.from(content);
	let width = 1;
	while (data.length >= 2 ** (7 * width) - 1) width++;
	const size = Buffer.alloc(width);
	size.writeUIntBE(data.length, 0, width);
	size[0] |= 1 << (8 - width);
	return Buffer.concat([Buffer.from(id, 'hex'), size, data]);
}

function track(id: number, type: number, name: string, language = 'eng') {
	return element('ae', Buffer.concat([
		element('d7', id), element('73c5', id), element('83', type), element('86', type === 1 ? 'V_MPEG4/ISO/AVC' : 'A_AAC'),
		element('536e', name), element('22b59c', language), element('88', id === 2 ? 1 : 0)
	]));
}

const tracks = element('1654ae6b', Buffer.concat([
	element('bf', Buffer.alloc(4)), track(1, 1, 'Video'), track(2, 2, 'Original'), track(3, 2, 'Français', 'fra')
]));
const payload = Buffer.concat([element('1f43b675', element('a3', Buffer.from('unchanged video and audio packets'))), element('1c53bb6b', Buffer.from('unchanged cues'))]);
const fixture = Buffer.concat([
	element('1a45dfa3', element('4282', 'matroska')),
	Buffer.from('18538067ff', 'hex'), tracks, payload
]);

let directory: string;
let file: string;
beforeEach(async () => {
	mocks.member.mockReset().mockResolvedValue({ id: 'member', role: 'member', enabled: true, approved: true });
	directory = await mkdtemp(path.join(os.tmpdir(), 'duck-audio-'));
	vi.stubEnv('DOWNLOADS_DIR', path.join(directory, 'downloads'));
	vi.stubEnv('SHARE_DIR', path.join(directory, 'share'));
	vi.stubEnv('FILE_DELIVERY', 'node');
	await Promise.all([mkdir(process.env.DOWNLOADS_DIR!), mkdir(process.env.SHARE_DIR!)]);
	file = path.join(process.env.SHARE_DIR!, 'film.mkv');
	await writeFile(file, fixture);
	await writeFile(path.join(process.env.SHARE_DIR!, 'film.mp4'), 'original MP4');
});
afterEach(async () => {
	vi.unstubAllEnvs();
	await rm(directory, { recursive: true, force: true });
});

function event(parameters = '', options: RequestInit = {}) {
	const url = new URL(`http://localhost/api/files/download?space=share&path=film.mkv${parameters}`);
	return { request: new Request(url, options), url } as RequestEvent<Record<string, never>, any>;
}

async function bytes(response: Response) { return Buffer.from(await response.arrayBuffer()); }

describe('MKV audio API and file delivery', () => {
	it.each([401, 403])('checks membership before reading tracks or media (%s)', async (status) => {
		mocks.member.mockRejectedValue({ status });
		await expect(audio(event('&path=../secret'))).rejects.toMatchObject({ status });
		await expect(download(event('&inline=1&audio=3'))).rejects.toMatchObject({ status });
	});

	it('lists audio track IDs and human-readable metadata', async () => {
		const response = await audio(event());
		expect(response.status).toBe(200);
		const result = await response.json();
		expect(result.audioTracks).toHaveLength(2);
		expect(result.audioTracks[0]).toMatchObject({ id: 2, label: expect.stringContaining('Original') });
		expect(result.audioTracks[1]).toMatchObject({ id: 3, label: expect.stringContaining('Français') });
		expect(JSON.stringify(result)).not.toContain(directory);
	});

	it('rejects unsafe paths, symbolic links and non-MKV metadata requests', async () => {
		const traversal = event(); traversal.url.searchParams.set('path', '../secret');
		await expect(audio(traversal)).rejects.toMatchObject({ status: 400 });
		await symlink(file, path.join(process.env.SHARE_DIR!, 'link.mkv'));
		const linked = event(); linked.url.searchParams.set('path', 'link.mkv');
		await expect(audio(linked)).rejects.toMatchObject({ status: 403 });
		const mp4 = event(); mp4.url.searchParams.set('path', 'film.mp4');
		await expect(audio(mp4)).rejects.toMatchObject({ status: 415 });
	});

	it.each(['', '0', '-1', '1.5', '1e0', 'NaN', '9007199254740992'])('rejects invalid audio ID %j', async (value) => {
		await expect(download(event(`&inline=1&audio=${value}`))).rejects.toMatchObject({ status: 400 });
	});

	it('rejects an unknown track and selecting audio in an unsupported container', async () => {
		await expect(download(event('&inline=1&audio=99'))).rejects.toMatchObject({ status: 400 });
		await expect(download(event('&audio=3'))).rejects.toMatchObject({ status: 400 });
		const mp4 = event('&inline=1&audio=3'); mp4.url.searchParams.set('path', 'film.mp4');
		await expect(download(mp4)).rejects.toMatchObject({ status: 400 });
	});

	it('puts the selected audio first without changing media packets, positions or the shared file', async () => {
		const response = await download(event('&inline=1&audio=3'));
		const selected = await bytes(response);
		expect(selected.length).toBe(fixture.length);
		expect(response.headers.get('content-length')).toBe(String(fixture.length));
		expect(response.headers.get('content-type')).toBe('video/x-matroska');
		expect(response.headers.get('accept-ranges')).toBe('bytes');
		expect(response.headers.get('cache-control')).toContain('no-store');
		expect(selected.indexOf(Buffer.from('Français'))).toBeLessThan(selected.indexOf(Buffer.from('Original')));
		expect(selected.subarray(fixture.length - payload.length)).toEqual(payload);
		expect(await readFile(file)).toEqual(fixture);
		expect(await bytes(await download(event('&inline=1')))).toEqual(fixture);
		expect(await bytes(await download(event()))).toEqual(fixture);
	});

	it('serves ranges through the changed header and unchanged media consistently', async () => {
		const selected = await bytes(await download(event('&inline=1&audio=3')));
		const ranges = [[0, 12], [tracks.length - 30, tracks.length + 20], [fixture.length - 12, fixture.length - 1]];
		for (const [start, end] of ranges) {
			const response = await download(event('&inline=1&audio=3', { headers: { range: `bytes=${start}-${end}` } }));
			expect(response.status).toBe(206);
			expect(response.headers.get('content-range')).toBe(`bytes ${start}-${end}/${fixture.length}`);
			expect(response.headers.get('content-length')).toBe(String(end - start + 1));
			expect(await bytes(response)).toEqual(selected.subarray(start, end + 1));
		}
		const suffix = await download(event('&inline=1&audio=3', { headers: { range: 'bytes=-15' } }));
		expect(await bytes(suffix)).toEqual(selected.subarray(-15));
	});

	it('rewrites track metadata that crosses stream chunk boundaries', async () => {
		const largeTracks = element('1654ae6b', Buffer.concat([
			track(1, 1, 'Video'), element('ec', Buffer.alloc(65500)), track(2, 2, 'Original'), track(3, 2, 'Français', 'fra')
		]));
		const large = Buffer.concat([element('1a45dfa3', element('4282', 'matroska')), Buffer.from('18538067ff', 'hex'), largeTracks, payload]);
		await writeFile(file, large);
		const selected = await bytes(await download(event('&inline=1&audio=3')));
		expect(selected.length).toBe(large.length);
		expect(selected.indexOf(Buffer.from('Français'))).toBeLessThan(selected.indexOf(Buffer.from('Original')));
		expect(selected.subarray(-payload.length)).toEqual(payload);
		const response = await download(event('&inline=1&audio=3', { headers: { range: 'bytes=65520-65630' } }));
		expect(await bytes(response)).toEqual(selected.subarray(65520, 65631));
	});

	it('preserves HEAD and unsatisfiable-range responses for selected audio', async () => {
		const head = await HEAD(event('&inline=1&audio=3', { method: 'HEAD' }));
		expect(head.status).toBe(200);
		expect(head.body).toBeNull();
		expect(head.headers.get('content-length')).toBe(String(fixture.length));
		const range = await HEAD(event('&inline=1&audio=3', { method: 'HEAD', headers: { range: 'bytes=10-19' } }));
		expect(range.status).toBe(206);
		expect(range.body).toBeNull();
		expect(range.headers.get('content-range')).toBe(`bytes 10-19/${fixture.length}`);
		const invalid = await download(event('&inline=1&audio=3', { headers: { range: `bytes=${fixture.length}-` } }));
		expect(invalid.status).toBe(416);
		expect(invalid.headers.get('content-range')).toBe(`bytes */${fixture.length}`);
	});

	it('bypasses Nginx for selected audio and preserves delegation for the original file', async () => {
		vi.stubEnv('FILE_DELIVERY', 'nginx');
		const response = await download(event('&inline=1&audio=3'));
		expect(response.headers.has('x-accel-redirect')).toBe(false);
		const selected = await bytes(response);
		expect(selected.indexOf(Buffer.from('Français'))).toBeLessThan(selected.indexOf(Buffer.from('Original')));
		const original = await download(event('&inline=1'));
		expect(original.body).toBeNull();
		expect(original.headers.get('x-accel-redirect')).toBe('/_protected/share/film.mkv');
	});
});
