import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({ read: vi.fn(), stat: vi.fn(), cpus: vi.fn() }));
vi.mock('node:fs/promises', () => ({ readFile: mocked.read, stat: mocked.stat }));
vi.mock('node:os', () => ({ cpus: mocked.cpus }));

beforeEach(() => {
	vi.resetModules();
	mocked.read.mockReset().mockResolvedValue('usage_usec 1000000\nuser_usec 500000\nsystem_usec 500000\n');
	mocked.stat.mockReset().mockResolvedValue({ ino: 1 });
	mocked.cpus.mockReset().mockReturnValue([{}, {}, {}, {}]);
	vi.spyOn(performance, 'now').mockReturnValue(1000);
});
afterEach(() => { vi.restoreAllMocks(); });

describe('service CPU metrics', () => {
	it('waits for a second sample and reports each service as a share of host CPU capacity', async () => {
		const { serviceMetrics } = await import('../src/lib/server/metrics');
		const first = await serviceMetrics();
		expect(first.cpuCount).toBe(4);
		expect(first.services).toEqual(['web', 'qbittorrent', 'postgres', 'nginx', 'ftp', 'studio'].map((id) => ({ id, cpuPercent: null })));
		mocked.read.mockResolvedValue('usage_usec 3000000\n');
		vi.mocked(performance.now).mockReturnValue(3000);
		const second = await serviceMetrics();
		expect(second.services.map((service) => service.cpuPercent)).toEqual([25, 25, 25, 25, 25, 25]);
		expect(mocked.read).toHaveBeenCalledWith('/host-cgroup/torrentduck.slice/torrentduck-web.slice/cpu.stat', 'utf8');
	});

	it('leaves a missing service unavailable without preventing metrics for other services', async () => {
		const { serviceMetrics } = await import('../src/lib/server/metrics');
		await serviceMetrics();
		mocked.read.mockImplementation(async (path: string) => {
			if (path.includes('-ftp.slice')) throw new Error('missing');
			return 'usage_usec 3000000\n';
		});
		vi.mocked(performance.now).mockReturnValue(3000);
		const partial = await serviceMetrics();
		expect(partial.services).toContainEqual({ id: 'ftp', cpuPercent: null });
		expect(partial.services).toContainEqual({ id: 'web', cpuPercent: 25 });
		mocked.read.mockResolvedValue('usage_usec 4000000\n');
		vi.mocked(performance.now).mockReturnValue(4000);
		expect((await serviceMetrics()).services).toContainEqual({ id: 'ftp', cpuPercent: null });
	});

	it.each(['usage_usec -1\n', 'usage_usec NaN\n', 'user_usec 1000000\n'])('rejects a malformed counter %j and recovers without a fabricated spike', async (contents) => {
		const { serviceMetrics } = await import('../src/lib/server/metrics');
		await serviceMetrics();
		mocked.read.mockResolvedValue(contents);
		vi.mocked(performance.now).mockReturnValue(3000);
		expect((await serviceMetrics()).services.every((service) => service.cpuPercent === null)).toBe(true);
		mocked.read.mockResolvedValue('usage_usec 4000000\n');
		vi.mocked(performance.now).mockReturnValue(4000);
		expect((await serviceMetrics()).services.every((service) => service.cpuPercent === null)).toBe(true);
	});

	it('resets the baseline when a cgroup is replaced or its counter resets', async () => {
		const { serviceMetrics } = await import('../src/lib/server/metrics');
		await serviceMetrics();
		mocked.stat.mockResolvedValue({ ino: 2 });
		mocked.read.mockResolvedValue('usage_usec 3000000\n');
		vi.mocked(performance.now).mockReturnValue(3000);
		expect((await serviceMetrics()).services.every((service) => service.cpuPercent === null)).toBe(true);
		mocked.read.mockResolvedValue('usage_usec 100\n');
		vi.mocked(performance.now).mockReturnValue(4000);
		expect((await serviceMetrics()).services.every((service) => service.cpuPercent === null)).toBe(true);
	});
});
