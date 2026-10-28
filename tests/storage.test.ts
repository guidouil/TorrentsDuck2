import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({ statfs: vi.fn() }));
vi.mock('node:fs/promises', () => ({ statfs: mocked.statfs }));
import { storageStatus, requireStorage } from '../src/lib/server/storage';

beforeEach(() => { mocked.statfs.mockReset().mockResolvedValue({ blocks: 100, bsize: 1000, bfree: 30, bavail: 25 }); });
afterEach(() => { vi.unstubAllEnvs(); });

describe('data volume capacity', () => {
	it('measures the mounted download filesystem rather than the container data directory', async () => {
		vi.stubEnv('DOWNLOADS_DIR', '/data/downloads');
		vi.stubEnv('DATA_ROOT', '/data');
		await storageStatus();
		expect(mocked.statfs).toHaveBeenCalledWith('/data/downloads');
	});

	it('keeps the data root fallback when no download directory is configured', async () => {
		vi.stubEnv('DOWNLOADS_DIR', undefined);
		vi.stubEnv('DATA_ROOT', '/volumes/data');
		await storageStatus();
		expect(mocked.statfs).toHaveBeenCalledWith('/volumes/data');
	});
	it('can protect a separate Studio or publication filesystem', async () => {
		await requireStorage(100, '/volumes/studio');
		expect(mocked.statfs).toHaveBeenCalledWith('/volumes/studio');
	});

	it('separates actual used space from filesystem and application reserves', async () => {
		expect(await storageStatus()).toEqual({ total: 100000, used: 70000, available: 25000, reserved: 10000, usable: 15000, canDownload: true });
	});

	it('continues enforcing the reserve using space available to the application', async () => {
		await expect(requireStorage(15000)).resolves.toMatchObject({ used: 70000 });
		await expect(requireStorage(15001)).rejects.toMatchObject({ status: 507 });
		mocked.statfs.mockResolvedValue({ blocks: 100, bsize: 1000, bfree: 30, bavail: 10 });
		await expect(requireStorage()).rejects.toMatchObject({ status: 507 });
	});
});
