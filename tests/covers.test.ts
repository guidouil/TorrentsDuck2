import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RequestEvent } from '@sveltejs/kit';
import { fileCover, movieTitle } from '../src/lib/server/covers';
import { GET } from '../src/routes/api/files/cover/+server';

const mocks = vi.hoisted(() => ({ member: vi.fn(), fetch: vi.fn(), storage: vi.fn() }));
vi.mock('../src/lib/server/permissions', () => ({ requireMember: mocks.member }));
vi.mock('../src/lib/server/network', () => ({ fetchSource: mocks.fetch }));
vi.mock('../src/lib/server/storage', () => ({ requireStorage: mocks.storage }));

const jpeg = Buffer.from([255, 216, 255, 224, 0, 16]);
const movie = { id: 1, title: 'Le Film', original_title: 'The Movie', release_date: '2024-03-01', poster_path: '/poster123.jpg' };
let directory: string;

function search(results: unknown[] = [movie]) { return { status: 200, contentType: 'application/json', body: Buffer.from(JSON.stringify({ results })) }; }
function image() { return { status: 200, contentType: 'image/jpeg', body: jpeg }; }
function event(requested = 'The.Movie.2024.1080p.mkv') {
	const url = new URL('http://localhost/api/files/cover');
	url.searchParams.set('space', 'share'); url.searchParams.set('path', requested);
	return { url, request: new Request(url) } as RequestEvent<Record<string, never>, any>;
}
async function cacheEntry() {
	const root = path.join(directory, 'cache/covers');
	const [filename] = await readdir(root);
	return { filename: path.join(root, filename), entry: JSON.parse(await readFile(path.join(root, filename), 'utf8')) };
}

beforeEach(async () => {
	vi.resetAllMocks();
	directory = await mkdtemp(path.join(os.tmpdir(), 'duck-covers-'));
	vi.stubEnv('DATA_ROOT', directory);
	vi.stubEnv('SHARE_DIR', path.join(directory, 'share'));
	vi.stubEnv('TMDB_READ_ACCESS_TOKEN', 'fictitious-test-token');
	await mkdir(process.env.SHARE_DIR!);
	await writeFile(path.join(process.env.SHARE_DIR!, 'The.Movie.2024.1080p.mkv'), 'video');
	mocks.member.mockResolvedValue({ id: 'member', role: 'member' });
	mocks.fetch.mockResolvedValueOnce(search()).mockResolvedValueOnce(image());
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });

describe('movie filename lookup', () => {
	it.each([
		['The.Movie.2024.1080p.BluRay.x264-GROUP.mkv', { title: 'The Movie', year: '2024' }],
		['[GROUP] Le.Film.(2024).MULTI.1080p.mkv', { title: 'Le Film', year: '2024' }],
		['folder/Été au village WEB-DL 1080p.mp4', { title: 'Été au village' }],
		['Blade.Runner.2049.2017.2160p.mkv', { title: 'Blade Runner 2049', year: '2017' }],
		['2001.A.Space.Odyssey.1968.mkv', { title: '2001 A Space Odyssey', year: '1968' }],
		['1984.mkv', { title: '1984' }],
		['Series.S01E02.2024.mkv', null],
		['Series.1x02.mkv', null]
	])('extracts a conservative movie title from %s', (name, expected) => { expect(movieTitle(name)).toEqual(expected); });
});

describe('server cover cache', () => {
	it('downloads a matching poster once, keeps credentials on the API and persists it across module reloads', async () => {
		expect(await fileCover('share', 'The.Movie.2024.1080p.mkv')).toEqual({ body: jpeg, contentType: 'image/jpeg' });
		const [searchUrl, headers, maximum, lockedOrigin] = mocks.fetch.mock.calls[0];
		expect(new URL(searchUrl).origin).toBe('https://api.themoviedb.org');
		expect(Object.fromEntries(new URL(searchUrl).searchParams)).toMatchObject({ query: 'The Movie', primary_release_year: '2024', language: 'fr-FR' });
		expect(headers).toEqual({ authorization: 'Bearer fictitious-test-token' });
		expect(maximum).toBe(512 * 1024); expect(lockedOrigin).toBe(true);
		expect(mocks.fetch.mock.calls[1]).toEqual(['https://image.tmdb.org/t/p/w342/poster123.jpg', {}, 512 * 1024, true]);
		vi.resetModules();
		const fresh = await import('../src/lib/server/covers');
		expect(await fresh.fileCover('share', 'The.Movie.2024.1080p.mkv')).toEqual({ body: jpeg, contentType: 'image/jpeg' });
		expect(mocks.fetch).toHaveBeenCalledTimes(2);
		const { entry } = await cacheEntry();
		expect(entry.expiresAt - Date.now()).toBeGreaterThan(29 * 86_400_000);
		expect(JSON.stringify(entry)).not.toContain('fictitious-test-token');
	});

	it('deduplicates concurrent requests for one movie', async () => {
		const covers = await Promise.all(Array.from({ length: 8 }, () => fileCover('share', 'The.Movie.2024.1080p.mkv')));
		expect(covers).toHaveLength(8); expect(covers.every(Boolean)).toBe(true);
		expect(mocks.fetch).toHaveBeenCalledTimes(2);
	});

	it('queues different movies behind at most two simultaneous lookups', async () => {
		let outstanding = 0, peak = 0;
		mocks.fetch.mockReset().mockImplementation(async (source: string) => {
			if (source.startsWith('https://image.tmdb.org/')) return image();
			outstanding++; peak = Math.max(peak, outstanding);
			await new Promise((resolve) => setTimeout(resolve, 5));
			outstanding--;
			return search([{ ...movie, title: new URL(source).searchParams.get('query') }]);
		});
		const files = Array.from({ length: 6 }, (_, index) => `Film ${index}.2024.mkv`);
		await Promise.all(files.map((name) => writeFile(path.join(process.env.SHARE_DIR!, name), 'video')));
		expect((await Promise.all(files.map((name) => fileCover('share', name)))).every(Boolean)).toBe(true);
		expect(peak).toBe(2); expect(outstanding).toBe(0);
	});

	it.each([
		[],
		[{ ...movie, title: 'Another Movie', original_title: 'Another Movie' }],
		[{ ...movie, release_date: '1999-01-01' }],
		[movie, { ...movie, id: 2 }],
		[{ ...movie, poster_path: '//private.example/cover.jpg' }],
		[{ ...movie, poster_path: '/../../secret.jpg' }]
	].map((results) => [results]))('negative-caches missing, ambiguous or unsafe posters', async (results) => {
		mocks.fetch.mockReset().mockResolvedValue(search(results));
		expect(await fileCover('share', 'The.Movie.2024.1080p.mkv')).toBeNull();
		expect(await fileCover('share', 'The.Movie.2024.1080p.mkv')).toBeNull();
		expect(mocks.fetch).toHaveBeenCalledOnce();
		const { entry } = await cacheEntry();
		expect(entry.expiresAt - Date.now()).toBeGreaterThan(23 * 3_600_000);
	});

	it('uses a short negative cache during a provider outage and retries after expiry', async () => {
		mocks.fetch.mockReset().mockRejectedValue(new Error('offline'));
		expect(await fileCover('share', 'The.Movie.2024.1080p.mkv')).toBeNull();
		expect(await fileCover('share', 'The.Movie.2024.1080p.mkv')).toBeNull();
		expect(mocks.fetch).toHaveBeenCalledOnce();
		const { filename, entry } = await cacheEntry();
		expect(entry.expiresAt - Date.now()).toBeLessThanOrEqual(300_000);
		await writeFile(filename, JSON.stringify({ ...entry, expiresAt: Date.now() - 1 }));
		mocks.fetch.mockReset().mockResolvedValueOnce(search()).mockResolvedValueOnce(image());
		expect(await fileCover('share', 'The.Movie.2024.1080p.mkv')).toEqual({ body: jpeg, contentType: 'image/jpeg' });
	});

	it('uses the fallback without external requests when no token is configured', async () => {
		vi.stubEnv('TMDB_READ_ACCESS_TOKEN', '');
		expect(await fileCover('share', 'The.Movie.2024.1080p.mkv')).toBeNull();
		expect(mocks.fetch).not.toHaveBeenCalled();
	});

	it('preserves disk reserve before searching or writing cache files', async () => {
		mocks.storage.mockRejectedValue({ status: 507 });
		expect(await fileCover('share', 'The.Movie.2024.1080p.mkv')).toBeNull();
		expect(mocks.fetch).not.toHaveBeenCalled();
	});

	it('refuses non-image responses even when their content type claims JPEG', async () => {
		mocks.fetch.mockReset().mockResolvedValueOnce(search()).mockResolvedValueOnce({ ...image(), body: Buffer.from('<html>untrusted</html>') });
		expect(await fileCover('share', 'The.Movie.2024.1080p.mkv')).toBeNull();
	});

	it('evicts the oldest cache entry at its 256-entry limit', async () => {
		const root = path.join(directory, 'cache/covers'); await mkdir(root, { recursive: true });
		await Promise.all(Array.from({ length: 256 }, (_, index) => writeFile(path.join(root, `${index.toString(16).padStart(64, '0')}.json`), '{}')));
		await fileCover('share', 'The.Movie.2024.1080p.mkv');
		expect(await readdir(root)).toHaveLength(256);
		expect((await cacheEntry()).filename).toMatch(/\.json$/);
	});
});

describe('cover API protection', () => {
	it.each([401, 403])('checks membership before touching file paths (%s)', async (status) => {
		mocks.member.mockRejectedValue({ status });
		await expect(GET(event('../secret'))).rejects.toMatchObject({ status });
		expect(mocks.fetch).not.toHaveBeenCalled();
	});

	it('serves cached binary images privately and redirects missing covers locally', async () => {
		const response = await GET(event());
		expect(response.status).toBe(200); expect(response.headers.get('content-type')).toBe('image/jpeg');
		expect(response.headers.get('cache-control')).toBe('private, no-store');
		expect(Buffer.from(await response.arrayBuffer())).toEqual(jpeg);
		vi.stubEnv('TMDB_READ_ACCESS_TOKEN', '');
		const fallback = await GET(event());
		expect(fallback.status).toBe(307); expect(fallback.headers.get('location')).toBe('/cover-placeholder.svg');
	});

	it('rejects traversal, directories, symbolic links and nonexistent files before using cache', async () => {
		await expect(GET(event('../secret'))).rejects.toMatchObject({ status: 400 });
		await expect(GET(event(''))).rejects.toMatchObject({ status: 400 });
		await expect(GET(event('missing.mkv'))).rejects.toMatchObject({ status: 404 });
		await symlink(path.join(process.env.SHARE_DIR!, 'The.Movie.2024.1080p.mkv'), path.join(process.env.SHARE_DIR!, 'link.mkv'));
		await expect(GET(event('link.mkv'))).rejects.toMatchObject({ status: 403 });
		expect(mocks.fetch).not.toHaveBeenCalled();
	});
});
