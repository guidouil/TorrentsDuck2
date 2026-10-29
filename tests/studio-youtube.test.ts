import http from 'node:http';
import { Duplex } from 'node:stream';
import type { Socket } from 'node:net';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({ lookup: vi.fn(), connect: vi.fn(), remotes: [] as Socket[] }));
vi.mock('node:dns/promises', () => ({ lookup: mocked.lookup }));
vi.mock('node:net', async (original) => ({ ...await original<typeof import('node:net')>(), connect: mocked.connect }));
import { withYoutubeProxy, youtubeDestination } from '../src/lib/server/studio-youtube';

function tunnel(proxy: string, authority = 'www.youtube.com:443') {
	return new Promise<Socket>((resolve, reject) => {
		const request = http.request(proxy, { method: 'CONNECT', path: authority });
		request.on('connect', (_response, socket) => { socket.on('error', () => {}); resolve(socket); });
		request.on('error', reject);
		request.end();
	});
}

beforeEach(() => {
	mocked.lookup.mockReset().mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
	mocked.remotes.length = 0;
	mocked.connect.mockReset().mockImplementation(() => {
		const remote = Object.assign(new Duplex({ read() {}, write(_chunk, _encoding, done) { done(); } }), { setTimeout: vi.fn() }) as unknown as Socket;
		mocked.remotes.push(remote);
		queueMicrotask(() => remote.emit('connect'));
		return remote;
	});
});

describe('YouTube download network boundary', () => {
	it.each(['youtube.com.evil.example:443', 'googlevideo.com@127.0.0.1:443', '127.0.0.1:443', 'www.youtube.com:80', 'www.youtube.com:5432', 'example.com:443'])('rejects other hosts and ports before DNS: %s', async (authority) => {
		await expect(youtubeDestination(authority, new AbortController().signal)).rejects.toThrow('interdite');
		expect(mocked.lookup).not.toHaveBeenCalled();
	});
	it.each(['127.0.0.1', '169.254.169.254', '172.30.10.2', '10.0.0.1', '::1'])('rejects private DNS answers, including mixed results: %s', async (address) => {
		mocked.lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }, { address, family: address.includes(':') ? 6 : 4 }]);
		await expect(youtubeDestination('www.youtube.com:443', new AbortController().signal)).rejects.toMatchObject({ status: 400 });
		expect(mocked.connect).not.toHaveBeenCalled();
	});
	it('pins the public DNS answer for the TCP tunnel and closes it after work', async () => {
		await withYoutubeProxy(new AbortController().signal, async (proxy) => {
			const socket = await tunnel(proxy, 'r1.googlevideo.com:443');
			expect(mocked.connect).toHaveBeenCalledWith({ host: '8.8.8.8', family: 4, port: 443 });
			const incoming = new Promise<string>((resolve) => socket.once('data', (data) => resolve(data.toString())));
			mocked.remotes[0].push('audio');
			expect(await incoming).toBe('audio');
			socket.destroy();
		});
		expect(mocked.remotes.every((remote) => remote.destroyed)).toBe(true);
	});
	it('caps actual received bytes across all connections, independently of Content-Length', async () => {
		await expect(withYoutubeProxy(new AbortController().signal, async (proxy, signal) => {
			const first = await tunnel(proxy);
			const second = await tunnel(proxy, 'r1.googlevideo.com:443');
			first.resume(); second.resume();
			mocked.remotes[0].push('1234');
			const stopped = new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
			mocked.remotes[1].push('5678');
			await stopped;
		}, 6)).rejects.toThrow('trop volumineuse');
		expect(mocked.remotes.every((remote) => remote.destroyed)).toBe(true);
	});
	it('aborts the downloader and destroys sockets when access is revoked or the task is cancelled', async () => {
		const controller = new AbortController();
		await expect(withYoutubeProxy(controller.signal, async (proxy, signal) => {
			await tunnel(proxy);
			const stopped = new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
			controller.abort(new Error('Accès révoqué.'));
			await stopped;
		})).rejects.toThrow('Accès révoqué');
		expect(mocked.remotes.every((remote) => remote.destroyed)).toBe(true);
	});
	it('fails the whole download on a forbidden redirect destination', async () => {
		await expect(withYoutubeProxy(new AbortController().signal, async (proxy) => {
			await tunnel(proxy, 'internal.example:443');
		})).rejects.toThrow('interdite');
		expect(mocked.connect).not.toHaveBeenCalled();
	});
});
