import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({ qbt: vi.fn(), urlSources: vi.fn(), searchUrlSource: vi.fn(), downloadUrlResult: vi.fn() }));
vi.mock('../src/lib/server/qbittorrent', () => ({ qbt: mocked.qbt }));
vi.mock('../src/lib/server/url-sources', async (importOriginal) => ({ SourceError: (await importOriginal<typeof import('../src/lib/server/url-sources')>()).SourceError, urlSources: mocked.urlSources, searchUrlSource: mocked.searchUrlSource, downloadUrlResult: mocked.downloadUrlResult }));

const plugins = [{ name: 'piratebay', enabled: true }, { name: 'nyaasi', enabled: false }, { name: 'unreviewed', enabled: true }];
const torrent = { fileName: 'Ubuntu', fileUrl: 'magnet:?xt=urn:btih:' + 'a'.repeat(40), fileSize: 1024, nbSeeders: 12, nbLeechers: 2, siteUrl: 'https://thepiratebay.org', descrLink: 'https://example.org/torrent' };

beforeEach(() => {
	vi.resetModules(); vi.useFakeTimers();
	mocked.urlSources.mockReset().mockResolvedValue([]);
	mocked.searchUrlSource.mockReset().mockResolvedValue([]);
	mocked.downloadUrlResult.mockReset();
	let engineId = 0;
	mocked.qbt.mockReset().mockImplementation(async (path: string) => {
		if (path === 'search/plugins') return Response.json(plugins);
		if (path === 'search/start') return Response.json({ id: ++engineId });
		if (path.startsWith('search/results?')) return Response.json({ status: 'Running', total: 1, results: [torrent] });
		return new Response('');
	});
});

const customSource = { id: 'url:00000000-0000-4000-8000-000000000001', name: 'Private source', url: 'https://index.example', kind: 'url', format: 'json', installed: true, enabled: true, hasAuth: true };
const customResult = {
	sourceId: customSource.id,
	result: { name: 'Ubuntu private fixture', size: 4096, seeders: 100, leechers: 25, publishedAt: 1_700_000_000_000, source: customSource.name,
		url: 'https://index.example/private-passkey/download?id=42&apikey=private-api-key', descriptionUrl: 'https://index.example/private-description?token=private-description-token' }
};

describe('detected URL sources in member searches', () => {
	beforeEach(() => {
		mocked.urlSources.mockResolvedValue([customSource]);
		mocked.searchUrlSource.mockResolvedValue([customResult]);
	});

	it('searches URL sources without requiring a working qBittorrent engine', async () => {
		mocked.qbt.mockRejectedValue({ status: 503 });
		const { startSearch, searchResults } = await import('../src/lib/server/torrent-search');
		const { id } = await startSearch('owner', 'Ubuntu', customSource.id);
		await vi.advanceTimersByTimeAsync(0);
		const page = await searchResults(id, 'owner', 0);
		expect(page).toMatchObject({ total: 1, running: false, results: [{ name: customResult.result.name, source: customSource.name }] });
		expect(mocked.searchUrlSource).toHaveBeenCalledWith(customSource.id, 'Ubuntu');
		expect(mocked.qbt.mock.calls.map(([path]) => path)).toEqual(['search/plugins']);
	});

	it('merges native and URL results before sorting and filtering', async () => {
		const { startSearch, searchResults } = await import('../src/lib/server/torrent-search');
		const { id } = await startSearch('owner', 'Ubuntu', undefined);
		await vi.advanceTimersByTimeAsync(0);
		const page = await searchResults(id, 'owner', 0, { sort: 'seeders' });
		expect(page.total).toBe(2);
		expect(page.results.map((result) => result.name)).toEqual([customResult.result.name, torrent.fileName]);
		expect((await searchResults(id, 'owner', 0, { sort: 'date' })).results[0].name).toBe(customResult.result.name);
		expect((await searchResults(id, 'owner', 0, { minSize: 2048 })).results).toHaveLength(1);
	});

	it.each(['start', 'results'])('keeps URL results when native %s fails and reports the unavailable engine', async (phase) => {
		mocked.qbt.mockImplementation(async (path: string) => {
			if (path === 'search/plugins') return Response.json(plugins);
			if (path === 'search/start') {
				if (phase === 'start') throw { status: 503 };
				return Response.json({ id: 1 });
			}
			throw { status: 503 };
		});
		const { startSearch, searchResults } = await import('../src/lib/server/torrent-search');
		const { id } = await startSearch('owner', 'Ubuntu', undefined);
		await vi.advanceTimersByTimeAsync(0);
		const page = await searchResults(id, 'owner', 0);
		expect(page.results).toHaveLength(1);
		expect(page.results[0].name).toBe(customResult.result.name);
		expect(page.diagnostics).toEqual([expect.objectContaining({ source: 'qBittorrent', diagnostic: expect.stringContaining('engine-unavailable') })]);
	});

	it('preserves a failed URL source diagnostic without hiding native results', async () => {
		const { SourceError } = await import('../src/lib/server/url-sources');
		mocked.searchUrlSource.mockRejectedValue(new SourceError('Source format unsupported.', '{"reason":"unsupported","structure":{"fields":["releases"]}}'));
		const { startSearch, searchResults } = await import('../src/lib/server/torrent-search');
		const { id } = await startSearch('owner', 'Ubuntu', undefined);
		await vi.advanceTimersByTimeAsync(0);
		const page = await searchResults(id, 'owner', 0);
		expect(page.results).toHaveLength(1);
		expect(page.results[0].name).toBe(torrent.fileName);
		expect(page.diagnostics).toEqual([{ source: customSource.name, message: 'Source format unsupported.', diagnostic: '{"reason":"unsupported","structure":{"fields":["releases"]}}' }]);
	});

	it('never exposes unexpected infrastructure error messages as source diagnostics', async () => {
		mocked.searchUrlSource.mockRejectedValue(new Error('postgresql://private-login:private-password@database'));
		const { startSearch, searchResults } = await import('../src/lib/server/torrent-search');
		const { id } = await startSearch('owner', 'Ubuntu', customSource.id);
		await vi.advanceTimersByTimeAsync(0);
		const page = await searchResults(id, 'owner', 0);
		expect(JSON.stringify(page)).not.toContain('private-password');
		expect(page.diagnostics).toHaveLength(1);
	});

	it('exposes opaque references and keeps URLs, passkeys and description tokens on the server', async () => {
		const { startSearch, searchResults } = await import('../src/lib/server/torrent-search');
		const { id } = await startSearch('owner', 'Ubuntu', customSource.id);
		await vi.advanceTimersByTimeAsync(0);
		const page = await searchResults(id, 'owner', 0);
		expect(page.results[0]).toMatchObject({ url: 'search:' + id + ':0', descriptionUrl: '' });
		const publicResponse = JSON.stringify(page);
		for (const secret of ['private-passkey', 'private-api-key', 'private-description-token', 'index.example']) expect(publicResponse).not.toContain(secret);
	});

	it('resolves downloads for the owner through the server-only source downloader', async () => {
		const file = new File(['d4:infodee'], 'fixture.torrent', { type: 'application/x-bittorrent' });
		mocked.downloadUrlResult.mockResolvedValue(file);
		const { startSearch, searchResults, resolveSearchResult, deleteSearch } = await import('../src/lib/server/torrent-search');
		const { id } = await startSearch('owner', 'Ubuntu', customSource.id);
		await vi.advanceTimersByTimeAsync(0);
		const reference = (await searchResults(id, 'owner', 0)).results[0].url;
		await expect(resolveSearchResult(reference, 'other')).rejects.toMatchObject({ status: 404 });
		await expect(resolveSearchResult('search:' + id + ':9999', 'owner')).rejects.toMatchObject({ status: 404 });
		expect(mocked.downloadUrlResult).not.toHaveBeenCalled();
		expect(await resolveSearchResult(reference, 'owner')).toBe(file);
		expect(mocked.downloadUrlResult).toHaveBeenCalledWith(customResult);
		await deleteSearch(id, 'owner');
		await expect(resolveSearchResult(reference, 'owner')).rejects.toMatchObject({ status: 404 });
	});

	it('discards late URL results after the member deletes the search', async () => {
		let finish!: (results: typeof customResult[]) => void;
		mocked.searchUrlSource.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
		const { startSearch, searchResults, deleteSearch, resolveSearchResult } = await import('../src/lib/server/torrent-search');
		const { id } = await startSearch('owner', 'Ubuntu', customSource.id);
		expect((await searchResults(id, 'owner', 0)).running).toBe(true);
		await deleteSearch(id, 'owner');
		finish([customResult]);
		await vi.advanceTimersByTimeAsync(0);
		await expect(searchResults(id, 'owner', 0)).rejects.toMatchObject({ status: 404 });
		await expect(resolveSearchResult('search:' + id + ':0', 'owner')).rejects.toMatchObject({ status: 404 });
		expect(vi.getTimerCount()).toBe(0);
	});
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('member torrent searches', () => {
	it('uses only enabled catalog plugins and never accepts a plugin URL', async () => {
		const { startSearch, searchSources } = await import('../src/lib/server/torrent-search');
		expect((await searchSources()).some((source) => source.id === 'unreviewed')).toBe(false);
		await expect(startSearch('member', 'Ubuntu', 'https://example.org/engine.py')).rejects.toMatchObject({ status: 400 });
		await expect(startSearch('member', 'x', undefined)).rejects.toMatchObject({ status: 400 });
		const { id } = await startSearch('member', ' Ubuntu ', undefined);
		expect(id).not.toBe('1');
		const body = mocked.qbt.mock.calls.find(([path]) => path === 'search/start')![1];
		expect(Object.fromEntries(body)).toEqual({ pattern: 'Ubuntu', plugins: 'piratebay', category: 'all' });
	});

	it('refuses inactive sources and bounds concurrent searches per member and globally', async () => {
		const { startSearch } = await import('../src/lib/server/torrent-search');
		await expect(startSearch('member', 'Ubuntu', 'nyaasi')).rejects.toMatchObject({ status: 400 });
		await startSearch('member', 'Ubuntu', 'piratebay');
		await expect(startSearch('member', 'Ubuntu', undefined)).rejects.toMatchObject({ status: 429 });
		await Promise.all(['two', 'three', 'four'].map((user) => startSearch(user, 'Ubuntu', undefined)));
		await expect(startSearch('five', 'Ubuntu', undefined)).rejects.toMatchObject({ status: 429 });
	});

	it('keeps results and deletion private to the member who started the search', async () => {
		const { startSearch, searchResults, deleteSearch } = await import('../src/lib/server/torrent-search');
		const { id } = await startSearch('owner', 'Ubuntu', undefined);
		mocked.qbt.mockClear();
		await expect(searchResults(id, 'other', 0)).rejects.toMatchObject({ status: 404 });
		await expect(deleteSearch(id, 'other')).rejects.toMatchObject({ status: 404 });
		await expect(searchResults(id, 'owner', -1)).rejects.toMatchObject({ status: 400 });
		expect(mocked.qbt).not.toHaveBeenCalled();
		const page = await searchResults(id, 'owner', 0);
		expect(page).toMatchObject({ total: 1, running: true, results: [{ name: 'Ubuntu', size: 1024, seeders: 12 }] });
		expect(mocked.qbt.mock.calls[0][0]).toBe('search/results?id=1&limit=2000&offset=0');
		await deleteSearch(id, 'owner');
		await expect(searchResults(id, 'owner', 0)).rejects.toMatchObject({ status: 404 });
		expect(mocked.qbt.mock.calls.map(([path]) => path)).toContain('search/stop');
	});

	it('filters unsafe links from external results and preserves unknown statistics', async () => {
		const { startSearch, searchResults } = await import('../src/lib/server/torrent-search');
		const { id } = await startSearch('member', 'Ubuntu', undefined);
		mocked.qbt.mockResolvedValueOnce(Response.json({ status: 'Stopped', total: 4, results: [
			{ ...torrent, fileUrl: 'javascript:alert(1)' },
			{ ...torrent, fileUrl: 'https://user:password@example.org/torrent' },
			null,
			{ ...torrent, descrLink: 'data:text/html,unsafe', fileSize: -1, nbSeeders: null }
		] }));
		const result = await searchResults(id, 'member', 0);
		expect(result.running).toBe(false);
		expect(result.results).toHaveLength(1);
		expect(result.results[0]).toMatchObject({ descriptionUrl: '', size: -1, seeders: -1 });
	});

	it('stops abandoned searches after 90 seconds and removes them after five minutes', async () => {
		const { startSearch, searchResults } = await import('../src/lib/server/torrent-search');
		const { id } = await startSearch('member', 'Ubuntu', undefined);
		await vi.advanceTimersByTimeAsync(90_000);
		expect(mocked.qbt.mock.calls.map(([path]) => path)).toContain('search/stop');
		await vi.advanceTimersByTimeAsync(210_000);
		expect(mocked.qbt.mock.calls.map(([path]) => path)).toContain('search/delete');
		await expect(searchResults(id, 'member', 0)).rejects.toMatchObject({ status: 404 });
	});

	it('retains expiry cleanup when an explicit deletion fails', async () => {
		const { startSearch, deleteSearch } = await import('../src/lib/server/torrent-search');
		const { id } = await startSearch('member', 'Ubuntu', undefined);
		mocked.qbt.mockRejectedValueOnce({ status: 503 });
		await expect(deleteSearch(id, 'member')).rejects.toMatchObject({ status: 503 });
		await vi.advanceTimersByTimeAsync(300_000);
		expect(mocked.qbt.mock.calls.map(([path]) => path)).toContain('search/delete');
	});

	it('releases a failed start so the member can try again', async () => {
		const { startSearch } = await import('../src/lib/server/torrent-search');
		mocked.qbt.mockResolvedValueOnce(Response.json(plugins)).mockRejectedValueOnce({ status: 503 });
		await expect(startSearch('member', 'Ubuntu', undefined)).rejects.toMatchObject({ status: 503 });
		await expect(startSearch('member', 'Ubuntu', undefined)).resolves.toHaveProperty('id');
	});

	it('sorts publication dates before pagination, with unknown dates last', async () => {
		const { startSearch, searchResults } = await import('../src/lib/server/torrent-search');
		const { id } = await startSearch('member', 'Ubuntu', undefined);
		const entries = [...Array.from({ length: 125 }, (_, index) => ({ ...torrent, fileName: 'Release ' + index, pubDate: 1_700_000_000 + index })), { ...torrent, fileName: 'Unknown', pubDate: -1 }];
		mocked.qbt.mockImplementation(async () => Response.json({ status: 'Stopped', total: entries.length, results: entries }));
		const first = await searchResults(id, 'member', 0, { sort: 'date' });
		const last = await searchResults(id, 'member', 100, { sort: 'date' });
		expect(first.results).toHaveLength(100);
		expect(first.results[0]).toMatchObject({ name: 'Release 124', publishedAt: 1_700_000_124_000 });
		expect(last.results[0].name).toBe('Release 24');
		expect(last.results.at(-1)).toMatchObject({ name: 'Unknown', publishedAt: null });
	});

	it('sorts seeders and leechers across pages and filters sizes and swarm health', async () => {
		const { startSearch, searchResults } = await import('../src/lib/server/torrent-search');
		const { id } = await startSearch('member', 'Ubuntu', undefined);
		const entries = Array.from({ length: 125 }, (_, index) => ({ ...torrent, fileName: 'Release ' + index, nbSeeders: index, nbLeechers: 125 - index, fileSize: index * 1024 }));
		mocked.qbt.mockImplementation(async () => Response.json({ status: 'Stopped', total: entries.length, results: entries }));
		expect((await searchResults(id, 'member', 0, { sort: 'seeders' })).results[0].seeders).toBe(124);
		expect((await searchResults(id, 'member', 100, { sort: 'leechers' })).results[0].leechers).toBe(25);
		const filtered = await searchResults(id, 'member', 0, { minSeeders: 20, minSize: 30 * 1024, maxSize: 40 * 1024 });
		expect(filtered.total).toBe(11);
		expect(filtered.results.every((entry: { size: number; seeders: number }) => entry.size >= 30 * 1024 && entry.size <= 40 * 1024 && entry.seeders >= 20)).toBe(true);
		await expect(searchResults(id, 'member', 0, { minSize: 20, maxSize: 10 })).rejects.toMatchObject({ status: 400 });
		await expect(searchResults(id, 'member', 0, { minSeeders: NaN })).rejects.toMatchObject({ status: 400 });
	});

	it('reports a bounded result set instead of silently presenting it as exhaustive', async () => {
		const { startSearch, searchResults } = await import('../src/lib/server/torrent-search');
		const { id } = await startSearch('member', 'Ubuntu', undefined);
		mocked.qbt.mockResolvedValueOnce(Response.json({ status: 'Stopped', total: 2500, results: Array.from({ length: 2001 }, () => torrent) }));
		expect(await searchResults(id, 'member', 0)).toMatchObject({ total: 2000, fetched: 2000, available: 2500, truncated: true });
	});

	it('retries expiry cleanup after an RPC outage and discards jobs missing after engine restart', async () => {
		const { startSearch, searchResults } = await import('../src/lib/server/torrent-search');
		const { id } = await startSearch('member', 'Ubuntu', undefined);
		mocked.qbt.mockRejectedValue({ status: 503 });
		await vi.advanceTimersByTimeAsync(300_000);
		await expect(searchResults(id, 'member', 0)).rejects.toMatchObject({ status: 404 });
		mocked.qbt.mockImplementation(async (path: string) => path === 'search/status' ? Response.json([]) : Promise.reject({ status: 503 }));
		await vi.advanceTimersByTimeAsync(30_000);
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe('approved source catalog', () => {
	it('installs only the bundled local plugin and does not execute a member URL', async () => {
		const { changeSearchSource } = await import('../src/lib/server/torrent-search');
		await expect(changeSearchSource('https://example.org/plugin.py', 'install')).rejects.toMatchObject({ status: 400 });
		await expect(changeSearchSource('piratebay', { toString: () => 'install' })).rejects.toMatchObject({ status: 400 });
		expect(mocked.qbt).not.toHaveBeenCalled();
		await changeSearchSource('piratebay', 'install');
		expect(mocked.qbt.mock.calls[0][0]).toBe('search/installPlugin');
		expect(mocked.qbt.mock.calls[0][1].get('sources')).toBe('/usr/local/share/torrentduck/search/piratebay.py');
	});
});
