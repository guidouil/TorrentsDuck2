import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const mocked = vi.hoisted(() => ({ list: vi.fn(), qbt: vi.fn(), authors: vi.fn(), storage: vi.fn(), member: vi.fn(), query: vi.fn(), metrics: vi.fn() }));
vi.mock('../src/lib/server/db', () => ({ query: mocked.query }));
vi.mock('../src/lib/server/qbittorrent', () => ({ listTorrents: mocked.list, qbt: mocked.qbt, syncAuthors: mocked.authors }));
vi.mock('../src/lib/server/storage', () => ({ storageStatus: mocked.storage }));
vi.mock('../src/lib/server/permissions', () => ({ requireMember: mocked.member }));
vi.mock('../src/lib/server/metrics', () => ({ serviceMetrics: mocked.metrics }));

beforeEach(() => {
	vi.resetModules();
	vi.useFakeTimers();
	mocked.list.mockReset().mockResolvedValue([{ hash: 'a'.repeat(40), name: 'Linux.iso', progress: 0.5, size: 1000, dlspeed: 2, upspeed: 3, ratio: 1, num_leechs: 2, num_seeds: 3, eta: 20, state: 'downloading' }]);
	mocked.qbt.mockReset().mockImplementation(async () => new Response(JSON.stringify({ dl_info_speed: 2, up_info_speed: 3, dl_info_data: 10, up_info_data: 20, connection_status: 'connected' })));
	mocked.authors.mockReset().mockResolvedValue(undefined);
	mocked.storage.mockReset().mockResolvedValue({ total: 100, available: 50, reserved: 10, usable: 40, canDownload: true });
	mocked.member.mockReset().mockResolvedValue({ id: 'member', enabled: true });
	mocked.query.mockReset().mockResolvedValue([{ hash: 'a'.repeat(40), user_id: 'member' }]);
	mocked.metrics.mockReset().mockResolvedValue({ cpuCount: 4, services: [{ id: 'web', cpuPercent: 12.5 }] });
});
afterEach(() => { vi.useRealTimers(); });

describe('shared live snapshot', () => {
	it('shares concurrent polling and preserves author and storage data', async () => {
		const { torrentSnapshot } = await import('../src/lib/server/torrent-stream');
		const [a, b] = await Promise.all([torrentSnapshot(), torrentSnapshot()]);
		expect(mocked.list).toHaveBeenCalledTimes(1);
		expect(a).toBe(b);
		expect(a.torrents[0]).toMatchObject({ authorId: 'member', peers: 5, downloadSpeed: 2 });
		expect(a.storage.canDownload).toBe(true);
		expect(a.sampledAt).toBe(Date.now());
		expect(a.metrics).toEqual({ cpuCount: 4, services: [{ id: 'web', cpuPercent: 12.5 }] });
		expect(mocked.metrics).toHaveBeenCalledOnce();
	});
	it('pauses incomplete transfers before the reserve is consumed, without resuming completed seeders', async () => {
		mocked.storage.mockResolvedValue({ total: 100, available: 10, reserved: 10, usable: 0, canDownload: false });
		mocked.list.mockResolvedValue([
			{ hash: 'a'.repeat(40), progress: 0.5, state: 'downloading' },
			{ hash: 'b'.repeat(40), progress: 1, state: 'uploading' },
			{ hash: 'c'.repeat(40), progress: 0.5, state: 'stoppedDL' }
		]);
		const { torrentSnapshot } = await import('../src/lib/server/torrent-stream');
		const snapshot = await torrentSnapshot();
		expect(snapshot.storage.pausedForStorage).toBe(true);
		expect(mocked.qbt).toHaveBeenCalledWith('torrents/stop', expect.any(URLSearchParams));
		const stopped = mocked.qbt.mock.calls.find(([route]) => route === 'torrents/stop');
		expect(stopped?.[1].get('hashes')).toBe('a'.repeat(40));
	});
	it('keeps protecting disk without connected browsers', async () => {
		const { startTorrentMonitor, stopTorrentMonitor } = await import('../src/lib/server/torrent-stream');
		startTorrentMonitor();
		await vi.advanceTimersByTimeAsync(0);
		expect(mocked.list).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(mocked.list).toHaveBeenCalledTimes(2);
		stopTorrentMonitor();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(mocked.list).toHaveBeenCalledTimes(2);
	});
	it('terminates a logged-out live stream on the next authentication check', async () => {
		const { subscribeTorrents } = await import('../src/lib/server/torrent-stream');
		const event = { request: new Request('http://localhost/api/events') } as RequestEvent;
		const response = subscribeTorrents(event, 'member');
		const reader = response.body!.getReader();
		expect(new TextDecoder().decode((await reader.read()).value)).toContain(': connected');
		expect(new TextDecoder().decode((await reader.read()).value)).toContain('event: snapshot');
		mocked.member.mockRejectedValue({ status: 401 });
		await vi.advanceTimersByTimeAsync(3000);
		expect(new TextDecoder().decode((await reader.read()).value)).toContain('event: unauthorized');
		expect((await reader.read()).done).toBe(true);
	});
	it('emits an explicit engine error and never a fabricated empty snapshot', async () => {
		mocked.list.mockRejectedValue(new Error('engine offline'));
		const { subscribeTorrents } = await import('../src/lib/server/torrent-stream');
		const response = subscribeTorrents({ request: new Request('http://localhost/api/events') } as RequestEvent, 'member');
		const reader = response.body!.getReader();
		await reader.read();
		expect(new TextDecoder().decode((await reader.read()).value)).toContain('event: engine-error');
		await reader.cancel();
	});
});
