import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({ lookup: vi.fn(), get: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: mocked.lookup }));
vi.mock('node:http', () => ({ default: { get: mocked.get } }));
vi.mock('node:https', () => ({ default: { get: mocked.get } }));
import { fetchTorrent } from '../src/lib/server/network';

function serve(status = 200, headers: Record<string, string> = {}, body = 'd4:infodee') {
	mocked.get.mockImplementationOnce((_url, _options, callback) => {
		const request = Object.assign(new EventEmitter(), { setTimeout: vi.fn(), destroy: (cause: Error) => request.emit('error', cause) });
		queueMicrotask(() => {
			const response = Object.assign(new EventEmitter(), { statusCode: status, headers, resume: vi.fn() });
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
