import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const mocks = vi.hoisted(() => ({ getSession: vi.fn(), query: vi.fn() }));
vi.mock('../src/lib/server/auth', () => ({ auth: { api: { getSession: mocks.getSession } } }));
vi.mock('../src/lib/server/db', () => ({ query: mocks.query }));

import { requireAdmin, requireInternal, requireMember, requireSourceManager } from '../src/lib/server/permissions';

const event = { request: new Request('http://localhost/api/files') } as RequestEvent;
const user = { id: 'member', name: 'Éric+', username: 'Éric+', email: 'eric@example.org', role: 'member', enabled: true, approved: true, canManageSources: false, emailVerified: false };

describe('private community access', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getSession.mockResolvedValue({ user: { id: 'member' } });
    mocks.query.mockResolvedValue([user]);
  });

  it('rejects anonymous requests before querying member data', async () => {
    mocks.getSession.mockResolvedValue(null);
    await expect(requireMember(event)).rejects.toMatchObject({ status: 401 });
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('checks live account status and never trusts cached session roles', async () => {
    mocks.getSession.mockResolvedValue({ user: { id: 'member', role: 'admin', enabled: true } });
    mocks.query.mockResolvedValue([{ ...user, enabled: false }]);
    await expect(requireMember(event)).rejects.toMatchObject({ status: 403 });
    expect(mocks.getSession).toHaveBeenCalledWith({ headers: event.request.headers, query: { disableCookieCache: true } });
  });

  it('permits members and requires administrator role for administration', async () => {
    expect(await requireMember(event)).toEqual(user);
    await expect(requireAdmin(event)).rejects.toMatchObject({ status: 403 });
    mocks.query.mockResolvedValue([{ ...user, role: 'admin' }]);
    expect((await requireAdmin(event)).role).toBe('admin');
  });

  it('refuses unapproved accounts even with administrator claims', async () => {
    mocks.query.mockResolvedValue([{ ...user, role: 'admin', approved: false }]);
    await expect(requireMember(event)).rejects.toMatchObject({ status: 403 });
    await expect(requireAdmin(event)).rejects.toMatchObject({ status: 403 });
  });

  it('grants source management to administrators or explicitly authorized members only', async () => {
    await expect(requireSourceManager(event)).rejects.toMatchObject({ status: 403 });
    mocks.query.mockResolvedValue([{ ...user, canManageSources: true }]);
    expect((await requireSourceManager(event)).id).toBe(user.id);
    await expect(requireAdmin(event)).rejects.toMatchObject({ status: 403 });
    mocks.query.mockResolvedValue([{ ...user, role: 'admin' }]);
    expect((await requireSourceManager(event)).role).toBe('admin');
  });

  it('checks source management revocation live instead of trusting session claims', async () => {
    mocks.getSession.mockResolvedValue({ user: { id: user.id, canManageSources: true } });
    await expect(requireSourceManager(event)).rejects.toMatchObject({ status: 403 });
  });

  it.each([{ enabled: false }, { approved: false }])('refuses source managers with revoked community access %j', async (flags) => {
    mocks.query.mockResolvedValue([{ ...user, canManageSources: true, ...flags }]);
    await expect(requireSourceManager(event)).rejects.toMatchObject({ status: 403 });
  });

  it('fails closed for missing, wrong or malformed internal secrets', () => {
    vi.stubEnv('INTERNAL_API_SECRET', 'x'.repeat(32));
    expect(() => requireInternal(new Request('http://localhost'))).toThrow();
    expect(() => requireInternal(new Request('http://localhost', { headers: { authorization: 'Bearer wrong' } }))).toThrow();
    try {
      requireInternal(new Request('http://localhost', { headers: { authorization: `Bearer ${'é'.repeat(32)}` } }));
      expect.fail('Malformed bearer token must be rejected');
    } catch (error) {
      expect(error).toMatchObject({ status: 401 });
    }
    expect(() => requireInternal(new Request('http://localhost', { headers: { authorization: `Bearer ${'x'.repeat(32)}` } }))).not.toThrow();
    vi.unstubAllEnvs();
  });
});
