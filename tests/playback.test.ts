import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';

const mocked = vi.hoisted(() => ({ query: vi.fn(), lstat: vi.fn(), resolveFile: vi.fn() }));
vi.mock('../src/lib/server/db', () => ({ query: mocked.query }));
vi.mock('node:fs/promises', () => ({ lstat: mocked.lstat }));
vi.mock('../src/lib/server/files', () => ({ fileSpace: (value: unknown) => value, resolveFile: mocked.resolveFile }));
import { createPlayback, revokePlayback, playbackFile } from '../src/lib/server/playback';

beforeEach(() => {
	mocked.query.mockReset().mockResolvedValue([]);
	mocked.lstat.mockReset().mockResolvedValue({ isFile: () => true });
	mocked.resolveFile.mockReset().mockResolvedValue({ absolute: '/data/downloads/video.mp4', relative: 'video.mp4' });
});

describe('revocable VLC links', () => {
	it('stores only the token hash with expiry, never the bearer secret', async () => {
		mocked.query.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 'link-id' }]);
		const link = await createPlayback('member', { space: 'downloads', path: 'video.mp4' }, 'https://duck.example');
		expect(link.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(link.url).toBe(`https://duck.example/api/files/play/${link.token}`);
		const stored = mocked.query.mock.calls[1][1][0];
		expect(stored).toBe(createHash('sha256').update(link.token).digest('hex'));
		expect(stored).not.toBe(link.token);
	});
	it('checks account state, expiry and revocation before resolving a file', async () => {
		await expect(playbackFile('x'.repeat(43))).rejects.toMatchObject({ status: 404 });
		const sql = mocked.query.mock.calls[0][0];
		expect(sql).toContain('p.revoked_at IS NULL');
		expect(sql).toContain('p.expires_at>now()');
		expect(sql).toContain('u.enabled=true');
		expect(sql).toContain('u.approved=true');
		await expect(playbackFile('invalid')).rejects.toMatchObject({ status: 404 });
	});
	it('only revokes links belonging to the authenticated member', async () => {
		mocked.query.mockResolvedValueOnce([{ id: 'link' }]);
		await revokePlayback('member', { id: 'link' });
		expect(mocked.query.mock.calls[0][0]).toContain('user_id=$1');
		expect(mocked.query.mock.calls[0][1][0]).toBe('member');
	});
});
