import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RequestEvent } from '@sveltejs/kit';
import { GET } from '../src/routes/api/torrents/[hash]/+server';

const mocked = vi.hoisted(() => ({ member: vi.fn(), list: vi.fn() }));
vi.mock('../src/lib/server/permissions', () => ({ requireMember: mocked.member }));
vi.mock('../src/lib/server/qbittorrent', () => ({ listTorrents: mocked.list, torrentAction: vi.fn() }));
vi.mock('../src/lib/server/db', () => ({ query: vi.fn() }));

const hash = 'a'.repeat(40);
const engineRoot = '/engine/downloads';
let directory: string;
let downloads: string;

beforeEach(async () => {
	vi.clearAllMocks();
	mocked.member.mockReset().mockResolvedValue({ id: 'member', role: 'member' });
	mocked.list.mockReset().mockResolvedValue([{ hash, name: 'Renamed torrent', content_path: '', save_path: engineRoot }]);
	directory = await mkdtemp(path.join(os.tmpdir(), 'duck-torrent-directory-'));
	downloads = path.join(directory, 'downloads');
	await mkdir(downloads);
	vi.stubEnv('DOWNLOADS_DIR', downloads);
	vi.stubEnv('QBT_DOWNLOAD_PATH', engineRoot);
});

afterEach(async () => {
	vi.unstubAllEnvs();
	await rm(directory, { recursive: true, force: true });
});

function event(value = hash) {
	const url = new URL(`https://duck.example.com/api/torrents/${encodeURIComponent(value)}`);
	return { request: new Request(url), url, params: { hash: value } } as RequestEvent<{ hash: string }, '/api/torrents/[hash]'>;
}

async function expectDirectory(relative: string, value = hash) {
	await expect(GET(event(value))).rejects.toMatchObject({
		status: 303,
		location: `/files?${new URLSearchParams({ space: 'downloads', path: relative })}`
	});
}

describe('torrent directory navigation', () => {
	it('uses the real content directory rather than the torrent name across different engine and web roots', async () => {
		await mkdir(path.join(downloads, 'Actual directory'));
		mocked.list.mockResolvedValue([{ hash, name: 'Renamed torrent', content_path: `${engineRoot}/Actual directory`, save_path: engineRoot }]);
		await expectDirectory('Actual directory');
	});

	it('opens downloads for a single file at its root', async () => {
		await writeFile(path.join(downloads, 'Linux.iso'), 'fixture');
		mocked.list.mockResolvedValue([{ hash, content_path: `${engineRoot}/Linux.iso`, save_path: engineRoot }]);
		await expectDirectory('');
	});

	it('opens the containing directory for a nested file and encodes special characters', async () => {
		const folder = 'Films/Été & hiver #1';
		await mkdir(path.join(downloads, folder), { recursive: true });
		await writeFile(path.join(downloads, folder, 'Film.mkv'), 'fixture');
		mocked.list.mockResolvedValue([{ hash, content_path: `${engineRoot}/${folder}/Film.mkv`, save_path: `${engineRoot}/Films` }]);
		await expectDirectory(folder);
	});

	it('falls back to the save directory before magnet metadata is available', async () => {
		await mkdir(path.join(downloads, 'Pending'));
		mocked.list.mockResolvedValue([{ hash, content_path: '', save_path: `${engineRoot}/Pending` }]);
		await expectDirectory('Pending');
	});

	it.each(['New torrent', 'Pending/New torrent'])('opens the existing parent when the final content entry is not created yet: %s', async (content) => {
		await mkdir(path.join(downloads, 'Pending'));
		mocked.list.mockResolvedValue([{ hash, content_path: `${engineRoot}/${content}`, save_path: engineRoot }]);
		await expectDirectory(content.includes('/') ? 'Pending' : '');
	});

	it('uses the default engine root when no override is configured', async () => {
		vi.stubEnv('QBT_DOWNLOAD_PATH', undefined);
		await mkdir(path.join(downloads, 'Collection'));
		mocked.list.mockResolvedValue([{ hash, content_path: '/data/downloads/Collection', save_path: '/data/downloads' }]);
		await expectDirectory('Collection');
	});

	it('accepts a 64-character torrent hash', async () => {
		const value = 'b'.repeat(64);
		mocked.list.mockResolvedValue([{ hash: value, content_path: '', save_path: engineRoot }]);
		await expectDirectory('', value);
	});

	it.each(['/outside/secret', '/engine/downloads-other/secret', '/engine/downloads/../share/secret'])('rejects content outside downloads: %s', async (content_path) => {
		mocked.list.mockResolvedValue([{ hash, content_path, save_path: engineRoot }]);
		await expect(GET(event())).rejects.toMatchObject({ status: 400 });
	});

	it('rejects symbolic links instead of redirecting into their targets', async () => {
		const outside = path.join(directory, 'outside');
		await mkdir(outside);
		await symlink(outside, path.join(downloads, 'escape'));
		mocked.list.mockResolvedValue([{ hash, content_path: `${engineRoot}/escape`, save_path: engineRoot }]);
		await expect(GET(event())).rejects.toMatchObject({ status: 403 });
	});

	it('does not hide an error in an intermediate path component', async () => {
		mocked.list.mockResolvedValue([{ hash, content_path: `${engineRoot}/Missing/Content`, save_path: engineRoot }]);
		await expect(GET(event())).rejects.toMatchObject({ status: 404 });
	});

	it.each(['', 'relative/content'])('rejects an unavailable or nonabsolute content path: %s', async (content_path) => {
		mocked.list.mockResolvedValue([{ hash, content_path, save_path: '' }]);
		await expect(GET(event())).rejects.toMatchObject({ status: 404 });
	});

	it('reports a removed or unknown torrent', async () => {
		mocked.list.mockResolvedValue([]);
		await expect(GET(event())).rejects.toMatchObject({ status: 404 });
	});

	it.each(['invalid', '../file', 'g'.repeat(40), 'a'.repeat(41)])('rejects an invalid hash before asking the engine: %s', async (value) => {
		await expect(GET(event(value))).rejects.toMatchObject({ status: 400 });
		expect(mocked.list).not.toHaveBeenCalled();
	});

	it.each([401, 403])('checks membership before reading torrents (%s)', async (status) => {
		mocked.member.mockRejectedValue({ status });
		await expect(GET(event('invalid'))).rejects.toMatchObject({ status });
		expect(mocked.list).not.toHaveBeenCalled();
	});
});
