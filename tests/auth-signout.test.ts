import { beforeEach, describe, expect, it, vi } from 'vitest';
import { betterAuth } from 'better-auth';

const mocks = vi.hoisted(() => ({ session: vi.fn(), query: vi.fn(), transaction: vi.fn(), clientQuery: vi.fn() }));
vi.mock('better-auth', () => ({ betterAuth: vi.fn((options) => ({ options })) }));
vi.mock('better-auth/api', async (importOriginal) => ({
  ...await importOriginal<typeof import('better-auth/api')>(),
  createAuthMiddleware: (callback: unknown) => callback,
  getSession: () => mocks.session,
  getSessionFromCtx: vi.fn()
}));
vi.mock('better-auth/plugins', () => ({ username: vi.fn(), deviceAuthorization: vi.fn() }));
vi.mock('../src/lib/server/db', () => ({ db: {}, query: mocks.query, transaction: mocks.transaction }));
vi.mock('../src/lib/server/mail', () => ({ sendResetEmail: vi.fn(), sendVerificationEmail: vi.fn() }));
vi.mock('../src/lib/server/audit', () => ({ audit: vi.fn() }));
vi.mock('../src/lib/server/permissions', () => ({ requireMember: vi.fn(), requireAdmin: vi.fn() }));

import '../src/lib/server/auth';

const before = vi.mocked(betterAuth).mock.calls[0][0].hooks!.before!;
const context = (path = '/sign-out') => ({ path, method: 'POST', headers: new Headers(), body: { userId: 'another-member' }, context: {}, returnHeaders: true, returnStatus: true });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ user: { id: 'current-member', enabled: true, approved: true } });
  mocks.clientQuery.mockResolvedValue({ rows: [] });
  mocks.transaction.mockImplementation(async (callback) => callback({ query: mocks.clientQuery }));
});

describe('global sign-out', () => {
  it.each([true, false])('revokes only the current account sessions and QR grants, approved=%s', async (approved) => {
    mocks.session.mockResolvedValue({ user: { id: 'current-member', enabled: true, approved } });
    await before(context() as never);
    expect(mocks.session).toHaveBeenCalledWith(expect.objectContaining({ asResponse: false, returnHeaders: false, returnStatus: false, query: { disableCookieCache: true, disableRefresh: true } }));
    expect(mocks.transaction).toHaveBeenCalledOnce();
    expect(mocks.clientQuery.mock.calls).toEqual([
      ['DELETE FROM "deviceCode" WHERE "userId"=$1', ['current-member']],
      ['DELETE FROM session WHERE "userId"=$1', ['current-member']]
    ]);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('does not revoke another account when the session is absent or already signed out', async () => {
    mocks.session.mockResolvedValue(null);
    await before(context() as never);
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.clientQuery).not.toHaveBeenCalled();
  });

  it('leaves other authentication endpoints unchanged', async () => {
    await before(context('/get-session') as never);
    expect(mocks.session).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('propagates a session lookup failure before attempting revocation', async () => {
    const failure = new Error('Session store unavailable');
    mocks.session.mockRejectedValue(failure);
    await expect(before(context() as never)).rejects.toBe(failure);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('propagates a failed revocation instead of reporting success', async () => {
    const failure = new Error('Session transaction failed');
    mocks.transaction.mockRejectedValue(failure);
    await expect(before(context() as never)).rejects.toBe(failure);
  });
});
