import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn(), transaction: vi.fn(), client: vi.fn(), fetch: vi.fn() }));
vi.mock('../src/lib/server/db', () => ({ query: mocks.query, transaction: mocks.transaction }));
vi.mock('../src/lib/server/network', () => ({ fetchSource: mocks.fetch, MAX_TORRENT_BYTES: 8 * 1024 * 1024 }));
import { addUrlSource, changeUrlSource, downloadUrlResult, searchUrlSource, testUrlSource, urlSources } from '../src/lib/server/url-sources';

const magnet = 'magnet:?xt=urn:btih:' + 'a'.repeat(40);
const input = { name: 'Fixture', url: 'https://source.example/search?q={query}&apikey=private-fixture-key', auth: { type: 'basic', username: 'fixture-login', password: 'fixture-password' } };
let stored: Record<string, unknown>;

beforeEach(() => {
	vi.stubEnv('BETTER_AUTH_SECRET', 'fixture-only-source-encryption-secret-0123456789');
	mocks.query.mockReset().mockImplementation(async () => stored ? [stored] : []);
	mocks.transaction.mockReset().mockImplementation(async (run) => run({ query: mocks.client }));
	mocks.client.mockReset().mockImplementation(async (sql: string, values: unknown[]) => {
		if (sql.startsWith('INSERT')) {
			stored = { id: values[0], name: values[1], origin: values[2], config: values[3], format: values[4], authenticated: values[5], enabled: true };
			return { rows: [{ id: values[0] }] };
		}
		return { rows: [] };
	});
	mocks.fetch.mockReset().mockResolvedValue({ url: 'https://source.example/search?q=ubuntu&apikey=private-fixture-key', status: 200, contentType: 'application/json', body: Buffer.from(JSON.stringify({ results: [{ name: 'Ubuntu', magnet, seeders: 4 }] })) });
	stored = undefined as never;
});

describe('declarative URL sources', () => {
	it('detects the response before adding and encrypts the full URL and credentials at rest', async () => {
		const added = await addUrlSource(input, 'manager');
		expect(added.source).toMatchObject({ kind: 'url', format: 'json', url: 'https://source.example', hasAuth: true, enabled: true });
		expect(stored.config).toMatch(/^v1\./);
		for (const secret of ['fixture-login', 'fixture-password', 'private-fixture-key', '/search']) {
			expect(JSON.stringify(stored)).not.toContain(secret);
			expect(JSON.stringify(await urlSources())).not.toContain(secret);
			expect(added.diagnostic).not.toContain(secret);
		}
		expect(mocks.fetch).toHaveBeenCalledWith('https://source.example/search?q=ubuntu&apikey=private-fixture-key', { Authorization: 'Basic ' + Buffer.from('fixture-login:fixture-password').toString('base64') }, 2 * 1024 * 1024, true);
		await testUrlSource(added.source.id);
		expect(mocks.fetch).toHaveBeenCalledTimes(2);
	});

	it.each([
		{ type: 'none', header: {} },
		{ type: 'bearer', token: 'fixture-token', header: { Authorization: 'Bearer fixture-token' } },
		{ type: 'apiKey', token: 'fixture-key', header: { 'X-Api-Key': 'fixture-key' } }
	])('supports $type authentication without returning secrets', async ({ header, ...auth }) => {
		const result = await addUrlSource({ ...input, auth }, 'manager');
		expect(mocks.fetch.mock.calls[0][1]).toEqual(header);
		expect(JSON.stringify(result)).not.toContain('fixture-token');
		expect(JSON.stringify(result)).not.toContain('fixture-key');
	});

	it.each([
		{ ...input, url: 'http://source.example/search?q={query}' },
		{ ...input, auth: { type: 'none' }, url: 'http://source.example/search?apikey=secret' },
		{ ...input, url: 'https://{query}.example/search' },
		{ ...input, url: 'https://user:password@source.example/search' },
		{ ...input, auth: { type: 'bearer', token: 'fixture\r\nInjected: bad' } },
		{ ...input, name: '' }
	])('rejects unsafe configuration before networking %#', async (value) => {
		await expect(addUrlSource(value, 'manager')).rejects.toHaveProperty('diagnostic');
		expect(mocks.fetch).not.toHaveBeenCalled();
		expect(mocks.transaction).not.toHaveBeenCalled();
	});

	it('accepts normalized HTTPS origins and encoded query placeholders', async () => {
		await addUrlSource({ ...input, url: 'HTTPS://SOURCE.EXAMPLE:443/search?q=%7Bquery%7D' }, 'manager');
		expect(mocks.fetch.mock.calls[0][0]).toBe('HTTPS://SOURCE.EXAMPLE:443/search?q=ubuntu');
	});

	it('refuses unknown formats and returns a safe diagnostic without saving the source', async () => {
		mocks.fetch.mockResolvedValueOnce({ url: 'https://source.example/?token=never-copy-this', status: 401, contentType: 'text/html', body: Buffer.from('<p>private-fixture-key fixture-password never-copy-this</p>') });
		let failure: any;
		try { await addUrlSource(input, 'manager'); } catch (cause) { failure = cause; }
		expect(failure.status).toBe(422);
		expect(failure.diagnostic).toContain('401');
		for (const secret of ['private-fixture-key', 'fixture-password', 'never-copy-this']) expect(failure.diagnostic).not.toContain(secret);
		expect(mocks.transaction).not.toHaveBeenCalled();
	});

	it('preserves a useful network failure category without including raw error values', async () => {
		mocks.fetch.mockRejectedValueOnce(new Error('Redirection vers une autre origine refusée pour protéger les identifiants.'));
		await expect(addUrlSource(input, 'manager')).rejects.toMatchObject({ diagnostic: expect.stringContaining('cross-origin-redirect') });
	});

	it('redacts credentials even if a provider echoes them in metadata or field names', async () => {
		mocks.fetch.mockResolvedValueOnce({ url: 'https://source.example', status: 200, contentType: 'application/fixture-password', body: Buffer.from('{"results":[],"private-fixture-key":"ignored"}') });
		const added = await addUrlSource(input, 'manager');
		expect(added.diagnostic).not.toContain('fixture-password');
		expect(added.diagnostic).not.toContain('private-fixture-key');
		expect(() => JSON.parse(added.diagnostic)).not.toThrow();
	});

	it('filters fixed feeds locally and prevents disabled sources from being used', async () => {
		const added = await addUrlSource({ ...input, url: 'https://source.example/feed' }, 'manager');
		expect(await searchUrlSource(added.source.id, 'unrelated')).toEqual([]);
		expect(await searchUrlSource(added.source.id, 'ubuntu')).toHaveLength(1);
		mocks.query.mockResolvedValueOnce([]);
		await expect(searchUrlSource(added.source.id, 'ubuntu')).rejects.toMatchObject({ diagnostic: expect.stringContaining('source-unavailable') });
	});

	it('fails closed when the encryption key changes, while still allowing source removal', async () => {
		const added = await addUrlSource(input, 'manager');
		vi.stubEnv('BETTER_AUTH_SECRET', 'other-fixture-only-source-secret-9876543210');
		await expect(testUrlSource(added.source.id)).rejects.toMatchObject({ diagnostic: expect.stringContaining('configuration-unreadable') });
		await changeUrlSource(added.source.id, 'uninstall');
		expect(mocks.query).toHaveBeenLastCalledWith('DELETE FROM search_sources WHERE id=$1', [stored.id]);
	});

	it('downloads authenticated torrents server-side and never forwards credentials to other origins', async () => {
		const added = await addUrlSource(input, 'manager');
		const result = { sourceId: added.source.id, result: { name: 'Ubuntu', size: -1, seeders: -1, leechers: -1, publishedAt: null, url: 'https://source.example/download?passkey=fixture-passkey', descriptionUrl: '', source: 'Fixture' } };
		mocks.fetch.mockResolvedValue({ url: result.result.url, status: 200, contentType: 'application/x-bittorrent', body: Buffer.from('d4:infodee') });
		expect(await downloadUrlResult(result)).toBeInstanceOf(File);
		expect(mocks.fetch.mock.calls.at(-1)?.slice(1)).toEqual([{ Authorization: 'Basic ' + Buffer.from('fixture-login:fixture-password').toString('base64') }, 8 * 1024 * 1024, true]);
		await downloadUrlResult({ ...result, result: { ...result.result, url: 'https://cache.example/file.torrent' } });
		expect(mocks.fetch.mock.calls.at(-1)?.[1]).toEqual({});
	});
});
