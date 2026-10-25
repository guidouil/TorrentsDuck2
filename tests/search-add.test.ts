import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ member: vi.fn(), resolve: vi.fn(), add: vi.fn(), storage: vi.fn(), invalidate: vi.fn(), audit: vi.fn() }));
vi.mock('../src/lib/server/permissions', () => ({ requireMember: mocks.member }));
vi.mock('../src/lib/server/torrent-search', () => ({ resolveSearchResult: mocks.resolve }));
vi.mock('../src/lib/server/qbittorrent', () => ({ addTorrent: mocks.add }));
vi.mock('../src/lib/server/storage', () => ({ requireStorage: mocks.storage }));
vi.mock('../src/lib/server/torrent-stream', () => ({ invalidateSnapshot: mocks.invalidate }));
vi.mock('../src/lib/server/audit', () => ({ audit: mocks.audit }));
import { POST } from '../src/routes/api/torrents/+server';

function event() {
	return { request: new Request('http://localhost/api/torrents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source: 'search:00000000-0000-4000-8000-000000000001:0' }) }) } as never;
}
beforeEach(() => {
	vi.resetAllMocks();
	mocks.member.mockResolvedValue({ id: 'owner' });
	mocks.add.mockResolvedValue({ ok: true });
});
describe('adding an opaque URL source result', () => {
	it('checks disk reserve before resolving and reuses the existing torrent addition', async () => {
		const file = new File(['d4:infodee'], 'fixture.torrent');
		mocks.resolve.mockResolvedValue(file);
		expect((await POST(event())).status).toBe(201);
		expect(mocks.storage.mock.invocationCallOrder[0]).toBeLessThan(mocks.resolve.mock.invocationCallOrder[0]);
		expect(mocks.resolve).toHaveBeenCalledWith('search:00000000-0000-4000-8000-000000000001:0', 'owner');
		expect(mocks.add).toHaveBeenCalledWith(file, 'owner');
		expect(mocks.invalidate).toHaveBeenCalledOnce();
	});
	it('refuses anonymous or storage-blocked additions before requesting protected data', async () => {
		mocks.member.mockRejectedValueOnce({ status: 401 });
		await expect(POST(event())).rejects.toMatchObject({ status: 401 });
		mocks.storage.mockRejectedValueOnce({ status: 507 });
		await expect(POST(event())).rejects.toMatchObject({ status: 507 });
		expect(mocks.resolve).not.toHaveBeenCalled();
		expect(mocks.add).not.toHaveBeenCalled();
	});
});
