import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ member: vi.fn(), manager: vi.fn(), start: vi.fn(), results: vi.fn(), remove: vi.fn(), sources: vi.fn(), change: vi.fn(), audit: vi.fn(), addUrl: vi.fn(), testUrl: vi.fn(), changeUrl: vi.fn() }));
vi.mock('../src/lib/server/permissions', () => ({ requireMember: mocks.member, requireSourceManager: mocks.manager, readJsonObject: (request: Request) => request.json() }));
vi.mock('../src/lib/server/torrent-search', () => ({ startSearch: mocks.start, searchResults: mocks.results, deleteSearch: mocks.remove, searchSources: mocks.sources, changeSearchSource: mocks.change }));
vi.mock('../src/lib/server/audit', () => ({ audit: mocks.audit }));
vi.mock('../src/lib/server/url-sources', async (importOriginal) => ({ SourceError: (await importOriginal<typeof import('../src/lib/server/url-sources')>()).SourceError, addUrlSource: mocks.addUrl, testUrlSource: mocks.testUrl, changeUrlSource: mocks.changeUrl }));

function event(body?: unknown) {
	return { request: new Request('http://localhost/api/search?id=private-id', { method: body ? 'POST' : 'GET', ...(body ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } } : {}) }), url: new URL('http://localhost/api/search?id=private-id') } as never;
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.member.mockRejectedValue({ status: 401 }); mocks.manager.mockRejectedValue({ status: 403 });
});

describe('search API authorization', () => {
	it('rejects anonymous searches and source listing before contacting the engine', async () => {
		const route = await import('../src/routes/api/search/+server');
		const sources = await import('../src/routes/api/search/sources/+server');
		for (const handler of [route.GET, route.POST, route.DELETE, sources.GET]) await expect(handler(event())).rejects.toMatchObject({ status: 401 });
		for (const call of [mocks.start, mocks.results, mocks.remove, mocks.sources]) expect(call).not.toHaveBeenCalled();
	});
	it('does not grant source management to ordinary members', async () => {
		mocks.member.mockResolvedValue({ id: 'member', role: 'member', canManageSources: false });
		const route = await import('../src/routes/api/search/sources/+server');
		await expect(route.POST(event({ id: 'piratebay', action: 'disable' }))).rejects.toMatchObject({ status: 403 });
		expect(mocks.change).not.toHaveBeenCalled();
	});
	it('allows delegated managers to change a catalog source and records the action', async () => {
		mocks.manager.mockResolvedValue({ id: 'manager', role: 'member', canManageSources: true });
		const route = await import('../src/routes/api/search/sources/+server');
		const response = await route.POST(event({ id: 'piratebay', action: 'disable' }));
		expect(response.status).toBe(200);
		expect(mocks.change).toHaveBeenCalledWith('piratebay', 'disable');
		expect(mocks.audit).toHaveBeenCalledWith('manager', 'search.source.disable', { source: 'piratebay' });
	});
	it('passes live member identity to search ownership checks', async () => {
		mocks.member.mockResolvedValue({ id: 'owner', role: 'member' });
		mocks.results.mockResolvedValue({ results: [], total: 0, running: false });
		const route = await import('../src/routes/api/search/+server');
		const response = await route.GET(event());
		expect(mocks.results).toHaveBeenCalledWith('private-id', 'owner', 0, { sort: 'seeders', minSeeders: 0, minSize: 0 });
		expect(response.headers.get('Cache-Control')).toBe('no-store');
	});
	 it('adds a URL only for a manager and audits its identifier without credentials', async () => {
		mocks.manager.mockResolvedValue({ id: 'manager' });
		mocks.addUrl.mockResolvedValue({ ok: true, source: { id: 'url:fixture', name: 'Fixture' }, diagnostic: '{"version":1}' });
		const route = await import('../src/routes/api/search/sources/+server');
		const body = { action: 'add', name: 'Fixture', url: 'https://fixture.example?q={query}', auth: { type: 'basic', username: 'fake-login', password: 'fake-password' } };
		const response = await route.POST(event(body));
		expect(response.status).toBe(201);
		expect(response.headers.get('Cache-Control')).toBe('no-store');
		expect(mocks.addUrl).toHaveBeenCalledWith(body, 'manager');
		expect(mocks.audit).toHaveBeenCalledWith('manager', 'search.source.add', { source: 'url:fixture' });
		expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain('fake-password');
	});
	it('returns a copiable diagnostic for an unsupported response', async () => {
		const { SourceError } = await import('../src/lib/server/url-sources');
		mocks.manager.mockResolvedValue({ id: 'manager' });
		mocks.addUrl.mockRejectedValue(new SourceError('Format inconnu.', '{"version":1,"reason":"unsupported"}'));
		const route = await import('../src/routes/api/search/sources/+server');
		const response = await route.POST(event({ action: 'add' }));
		expect(response.status).toBe(422);
		expect(await response.json()).toEqual({ message: 'Format inconnu.', diagnostic: '{"version":1,"reason":"unsupported"}' });
		expect(response.headers.get('Cache-Control')).toBe('no-store');
	});
});
