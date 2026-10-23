import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({ query: vi.fn(), storage: vi.fn(), fetchTorrent: vi.fn() }));
vi.mock('../src/lib/server/db', () => ({ query: mocked.query }));
vi.mock('../src/lib/server/storage', () => ({ requireStorage: mocked.storage }));
vi.mock('../src/lib/server/network', () => ({ fetchTorrent: mocked.fetchTorrent, MAX_TORRENT_BYTES: 8 * 1024 * 1024 }));

beforeEach(() => {
	vi.resetModules();
	vi.unstubAllGlobals();
	mocked.query.mockReset().mockResolvedValue([]);
	mocked.storage.mockReset().mockResolvedValue({ canDownload: true });
	mocked.fetchTorrent.mockReset();
	process.env.QBT_URL = 'http://engine:8080';
	process.env.QBT_USERNAME = 'duck';
	process.env.QBT_PASSWORD = 'private-engine-password';
});

function loggedIn() { return new Response('Ok.', { headers: { 'set-cookie': 'SID=private-cookie; HttpOnly' } }); }

describe('private qBittorrent RPC', () => {
	it('shares one login and retries a stale cookie once', async () => {
		const fetch = vi.fn()
			.mockResolvedValueOnce(loggedIn())
			.mockResolvedValueOnce(new Response('Denied', { status: 403 }))
			.mockResolvedValueOnce(loggedIn())
			.mockResolvedValueOnce(new Response('[]'));
		vi.stubGlobal('fetch', fetch);
		const { qbt } = await import('../src/lib/server/qbittorrent');
		expect(await (await qbt('torrents/info')).json()).toEqual([]);
		expect(fetch).toHaveBeenCalledTimes(4);
		expect(fetch.mock.calls[1][1].headers.Cookie).toBe('SID=private-cookie');
	});
	it('reports engine failure instead of an empty list', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(loggedIn()).mockResolvedValue(new Response('no', { status: 403 })));
		const { listTorrents } = await import('../src/lib/server/qbittorrent');
		await expect(listTorrents()).rejects.toMatchObject({ status: 503 });
	});
	it('does not contact the engine if reserve disk is reached', async () => {
		const fetch = vi.fn();
		vi.stubGlobal('fetch', fetch);
		mocked.storage.mockRejectedValue({ status: 507 });
		const { addTorrent } = await import('../src/lib/server/qbittorrent');
		await expect(addTorrent('magnet:?xt=urn:btih:0123456789012345678901234567890123456789', 'member')).rejects.toMatchObject({ status: 507 });
		expect(fetch).not.toHaveBeenCalled();
	});
	it('requires a valid infohash and explicit destructive confirmation', async () => {
		vi.stubGlobal('fetch', vi.fn());
		const { addTorrent, torrentAction } = await import('../src/lib/server/qbittorrent');
		await expect(addTorrent('magnet:?xt=urn:btih:bad', 'member')).rejects.toMatchObject({ status: 400 });
		await expect(torrentAction('0123456789012345678901234567890123456789', 'delete')).rejects.toMatchObject({ status: 400 });
		await expect(torrentAction('../file', 'delete', true)).rejects.toMatchObject({ status: 400 });
	});
	it('separates removal from data deletion and retains author rows on engine failure', async () => {
		const hash = '0123456789012345678901234567890123456789';
		const fetch = vi.fn().mockResolvedValueOnce(loggedIn())
			.mockResolvedValueOnce(new Response(JSON.stringify([{ hash }])))
			.mockResolvedValueOnce(new Response(''));
		vi.stubGlobal('fetch', fetch);
		const { torrentAction } = await import('../src/lib/server/qbittorrent');
		await torrentAction(hash, 'remove');
		expect(fetch.mock.calls[2][1].body.get('deleteFiles')).toBe('false');
		expect(mocked.query).toHaveBeenCalledWith('DELETE FROM torrent_authors WHERE hash=$1', [hash]);
		mocked.query.mockClear();
		fetch.mockResolvedValueOnce(new Response(JSON.stringify([{ hash }]))).mockResolvedValueOnce(new Response('Failed', { status: 500 }));
		await expect(torrentAction(hash, 'delete', true)).rejects.toMatchObject({ status: 503 });
		expect(mocked.query).not.toHaveBeenCalled();
	});
	it('persists author tags in one query without overwriting the original author', async () => {
		const { syncAuthors } = await import('../src/lib/server/qbittorrent');
		await syncAuthors([{ hash: 'hash', tags: `duck-author-${Buffer.from('member-1').toString('base64url')}` } as never]);
		expect(mocked.query).toHaveBeenCalledTimes(1);
		expect(mocked.query.mock.calls[0][0]).toContain('ON CONFLICT(hash) DO NOTHING');
		expect(mocked.query.mock.calls[0][1]).toEqual([['hash'], ['member-1']]);
	});
	it('permits restarting an already completed seeder when download reserve is reached', async () => {
		const hash = 'a'.repeat(40);
		const fetch = vi.fn().mockResolvedValueOnce(loggedIn())
			.mockResolvedValueOnce(new Response(JSON.stringify([{ hash, progress: 1 }])))
			.mockResolvedValueOnce(new Response(''));
		vi.stubGlobal('fetch', fetch);
		mocked.storage.mockRejectedValue({ status: 507 });
		const { torrentAction } = await import('../src/lib/server/qbittorrent');
		await expect(torrentAction(hash, 'start')).resolves.toEqual({ ok: true });
		expect(mocked.storage).not.toHaveBeenCalled();
	});
});
