import { EventEmitter } from 'node:events';
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({ lookup: vi.fn(), get: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: mocked.lookup }));
vi.mock('node:http', () => ({ default: { get: mocked.get } }));
vi.mock('node:https', () => ({ default: { get: mocked.get } }));
import { fetchSource, fetchTorrent } from '../src/lib/server/network';

function serve(status = 200, headers: Record<string, string> = {}, body: string | Buffer = 'd4:infodee') {
	mocked.get.mockImplementationOnce((_url, _options, callback) => {
		const request = Object.assign(new EventEmitter(), { setTimeout: vi.fn(), destroy: (cause: Error) => request.emit('error', cause) });
		queueMicrotask(() => {
			const response = Object.assign(new EventEmitter(), { statusCode: status, headers, resume: vi.fn(), destroy: vi.fn() });
			callback(response);
			response.emit('data', Buffer.from(body));
			response.emit('end');
		});
		return request;
	});
}

beforeEach(() => { mocked.lookup.mockReset(); mocked.get.mockReset(); });

describe('pinned HTTP torrent fetching', () => {
	it('pins the checked DNS result for the transport, avoiding a second DNS lookup', async () => {
		mocked.lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
		serve();
		expect(await fetchTorrent('https://public.example/linux.torrent')).toEqual(Buffer.from('d4:infodee'));
		const options = mocked.get.mock.calls[0][1];
		const callback = vi.fn();
		options.lookup('public.example', {}, callback);
		expect(callback).toHaveBeenCalledWith(null, '8.8.8.8', 4);
		expect(options.family).toBe(4);
		expect(mocked.lookup).toHaveBeenCalledTimes(1);
	});
	it('checks every redirect before touching its destination', async () => {
		mocked.lookup.mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }]).mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }]);
		serve(302, { location: 'http://internal.example/secret' });
		await expect(fetchTorrent('https://public.example/linux.torrent')).rejects.toMatchObject({ status: 400 });
		expect(mocked.get).toHaveBeenCalledTimes(1);
	});
	it('rejects mixed public/private DNS answers', async () => {
		mocked.lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }]);
		await expect(fetchTorrent('https://public.example/linux.torrent')).rejects.toMatchObject({ status: 400 });
		expect(mocked.get).not.toHaveBeenCalled();
	});
	it('caps the response size rather than trusting Content-Length', async () => {
		mocked.lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
		serve(200, { 'content-length': '1' }, 'd'.repeat(8 * 1024 * 1024 + 1));
		await expect(fetchTorrent('https://public.example/linux.torrent')).rejects.toThrow('trop volumineux');
	});
});

describe('bounded source response fetching', () => {
	beforeEach(() => { mocked.lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]); });

	it('returns bounded error pages with HTTP metadata for a useful diagnostic', async () => {
		serve(403, { 'content-type': 'text/html; charset=utf-8' }, '<h1>Access denied</h1>');
		expect(await fetchSource('https://public.example/search?q=ubuntu')).toEqual({ url: 'https://public.example/search?q=ubuntu', status: 403, contentType: 'text/html', body: Buffer.from('<h1>Access denied</h1>') });
		const options = mocked.get.mock.calls[0][1];
		const callback = vi.fn();
		options.lookup('public.example', {}, callback);
		expect(callback).toHaveBeenCalledWith(null, '8.8.8.8', 4);
		expect(options.headers.cookie).toBeUndefined();
	});

	it('rechecks public DNS on every redirect, including mixed answers', async () => {
		mocked.lookup.mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }]).mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }]);
		serve(302, { location: 'https://redirect.example/search' });
		await expect(fetchSource('https://public.example/search')).rejects.toMatchObject({ status: 400 });
		expect(mocked.get).toHaveBeenCalledTimes(1);
	});

	it('requires HTTPS before sending credentials and rejects unsafe headers', async () => {
		await expect(fetchSource('http://public.example/search', { Authorization: 'Basic fixture' })).rejects.toMatchObject({ status: 400 });
		await expect(fetchSource('https://public.example/search', { Cookie: 'session=fixture' })).rejects.toMatchObject({ status: 400 });
		await expect(fetchSource('https://public.example/search', { 'X-Api-Key': 'fixture\r\nHost: private' })).rejects.toMatchObject({ status: 400 });
		expect(mocked.lookup).not.toHaveBeenCalled();
		expect(mocked.get).not.toHaveBeenCalled();
	});

	it('keeps credentials on same-origin redirects and refuses to forward them elsewhere', async () => {
		serve(302, { location: '/next' }); serve(200, { 'content-type': 'application/json' }, '[]');
		await fetchSource('https://public.example/search', { Authorization: 'Bearer fixture', 'X-Api-Key': 'fixture-key' });
		for (const [, options] of mocked.get.mock.calls) expect(options.headers).toMatchObject({ authorization: 'Bearer fixture', 'x-api-key': 'fixture-key' });
		mocked.get.mockClear(); mocked.lookup.mockClear();
		serve(302, { location: 'https://elsewhere.example/search' });
		await expect(fetchSource('https://public.example/search', { Authorization: 'Bearer fixture' })).rejects.toThrow('autre origine');
		expect(mocked.get).toHaveBeenCalledTimes(1);
		expect(mocked.lookup).toHaveBeenCalledTimes(1);
	});

	it.each(['https://elsewhere.example/search', 'http://public.example/search'])('protects URL credentials against a redirect to %s without auth headers', async (location) => {
		serve(302, { location });
		await expect(fetchSource('https://public.example/passkey-fixture/search?apikey=fixture', {}, 2 * 1024 * 1024, true)).rejects.toThrow('Redirection vers une autre origine refusée pour protéger les identifiants.');
		expect(mocked.get).toHaveBeenCalledTimes(1);
		expect(mocked.lookup).toHaveBeenCalledTimes(1);
	});

	it('bounds the wire response without trusting Content-Length', async () => {
		serve(200, { 'content-length': '1' }, 'x'.repeat(2 * 1024 * 1024 + 1));
		await expect(fetchSource('https://public.example/search')).rejects.toThrow('trop volumineuse');
	});

	it.each([
		['gzip', gzipSync], ['br', brotliCompressSync], ['deflate', deflateSync]
	] as const)('decodes %s responses with the same output size limit', async (encoding, compress) => {
		serve(200, { 'content-encoding': encoding, 'content-type': 'application/json' }, compress(Buffer.from('[{"name":"Fixture"}]')));
		expect((await fetchSource('https://public.example/search')).body.toString()).toBe('[{"name":"Fixture"}]');
		serve(200, { 'content-encoding': encoding }, compress(Buffer.alloc(2 * 1024 * 1024 + 1)));
		await expect(fetchSource('https://public.example/search')).rejects.toThrow('trop volumineuse');
	});

	it('allows an explicit torrent payload limit without permitting unlimited reads', async () => {
		serve(200, {}, Buffer.alloc(3 * 1024 * 1024));
		expect((await fetchSource('https://public.example/file.torrent', {}, 8 * 1024 * 1024)).body.length).toBe(3 * 1024 * 1024);
		await expect(fetchSource('https://public.example/file', {}, 8 * 1024 * 1024 + 1)).rejects.toMatchObject({ status: 400 });
	});

	it('caps redirects and masks errors that could contain a URL or credentials', async () => {
		for (let redirect = 0; redirect < 4; redirect++) serve(302, { location: '/next' });
		await expect(fetchSource('https://public.example/search')).rejects.toThrow('Trop de redirections');
		mocked.get.mockImplementationOnce(() => { throw new Error('https://private:secret@public.example/?apikey=secret'); });
		await expect(fetchSource('https://public.example/search')).rejects.toThrow('La requête vers la source a échoué.');
	});

	it.each([false, true])('bounds DNS and the whole redirect chain (redirects: %s)', async (redirects) => {
		vi.useFakeTimers();
		const timeouts = vi.spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds) => {
			const controller = new AbortController();
			setTimeout(() => controller.abort(), milliseconds);
			return controller.signal;
		});
		try {
			mocked.lookup.mockImplementation(() => new Promise((resolve) => {
				if (redirects) setTimeout(() => resolve([{ address: '8.8.8.8', family: 4 }]), 8000);
			}));
			if (redirects) for (let index = 0; index < 3; index++) serve(302, { location: '/next' });
			const pending = expect(fetchSource('https://public.example/search')).rejects.toMatchObject({ status: 400 });
			await vi.advanceTimersByTimeAsync(redirects ? 30_000 : 10_000);
			await pending;
			expect(mocked.get).toHaveBeenCalledTimes(redirects ? 3 : 0);
		} finally { timeouts.mockRestore(); vi.clearAllTimers(); vi.useRealTimers(); }
	});
});
