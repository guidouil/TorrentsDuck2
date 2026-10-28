import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const mocks = vi.hoisted(() => ({ getSession: vi.fn(), query: vi.fn(), transaction: vi.fn(), clientQuery: vi.fn() }));
vi.mock('../src/lib/server/auth', () => ({ auth: { api: { getSession: mocks.getSession } } }));
vi.mock('../src/lib/server/db', () => ({ query: mocks.query, transaction: mocks.transaction }));

import { DELETE, GET, POST } from '../src/routes/api/admin/users/+server';

const member = { id: 'member', username: 'Member', role: 'member', enabled: true, approved: true, canManageSources: false };
const admin = { ...member, id: 'admin', role: 'admin' };
function event(body: unknown, method = 'POST'): RequestEvent {
  return { params: {}, request: new Request('http://localhost/api/admin/users', { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) } as unknown as RequestEvent;
}

describe('user administration', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getSession.mockResolvedValue({ user: { id: admin.id } });
    mocks.query.mockResolvedValue([admin]);
    mocks.transaction.mockImplementation(async (callback) => callback({ query: mocks.clientQuery }));
    mocks.clientQuery.mockImplementation(async (sql: string, values?: unknown[]) => {
      if (sql.startsWith('SELECT id,role')) return { rows: [member] };
      if (sql.startsWith('UPDATE "user"')) return { rows: [{ ...member, canManageSources: values?.[4] }] };
      return { rows: [] };
    });
  });

  it.each([true, false])('allows administrators to set the source permission to %s and audits it', async (canManageSources) => {
    const response = await POST(event({ id: member.id, canManageSources }) as never);
    expect((await response.json()).user).toMatchObject({ role: 'member', canManageSources });
    expect(mocks.clientQuery).toHaveBeenCalledWith(expect.stringContaining('"canManageSources"=COALESCE($5,"canManageSources")'), [member.id, null, null, null, canManageSources]);
    expect(mocks.clientQuery).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO audit_log'), [admin.id, member.id, JSON.stringify({ enabled: true, approved: true, role: 'member', canManageSources, roleChanged: false })]);
    expect(mocks.clientQuery.mock.calls.some(([sql]) => sql.startsWith('DELETE FROM session'))).toBe(false);
  });

  it.each(['true', 1, null])('rejects malformed source permissions %j before opening a transaction', async (canManageSources) => {
    await expect(POST(event({ id: member.id, canManageSources }) as never)).rejects.toMatchObject({ status: 400 });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('refuses account administration to source managers', async () => {
    mocks.query.mockResolvedValue([{ ...member, canManageSources: true }]);
    await expect(POST(event({ id: member.id, canManageSources: true }) as never)).rejects.toMatchObject({ status: 403 });
    await expect(GET(event({}) as never)).rejects.toMatchObject({ status: 403 });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('includes source management permissions in the administrator list', async () => {
    await GET(event({}) as never);
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining('approved, "canManageSources", "createdAt"'));
  });

  it('lists pending accounts with their unverified email addresses', async () => {
    const pending = { ...member, email: 'discreet@example.invalid', emailVerified: false, approved: false };
    mocks.query.mockResolvedValueOnce([admin]).mockResolvedValueOnce([pending]);

    const response = await GET(event({}) as never);

    expect(await response.json()).toEqual({ users: [pending] });
    expect(mocks.query).toHaveBeenLastCalledWith(expect.stringMatching(/^SELECT .*username, email,.*approved,.*"emailVerified" FROM "user" ORDER BY/));
  });

  it('approves an account with a fictional email without verifying the address or revoking sessions', async () => {
    const pending = { ...member, email: 'discreet@example.invalid', emailVerified: false, approved: false };
    mocks.clientQuery.mockImplementation(async (sql: string, values?: unknown[]) => {
      if (sql.startsWith('SELECT id,role')) return { rows: [pending] };
      if (sql.startsWith('UPDATE "user"')) return { rows: [{ ...pending, approved: values?.[3] }] };
      return { rows: [] };
    });

    const response = await POST(event({ id: pending.id, approved: true }) as never);

    expect((await response.json()).user).toMatchObject({ email: pending.email, emailVerified: false, approved: true });
    expect(mocks.clientQuery).toHaveBeenCalledWith(expect.stringContaining('approved=COALESCE($4,approved)'), [pending.id, null, null, true, null]);
    const updates = mocks.clientQuery.mock.calls.filter(([sql]) => sql.startsWith('UPDATE "user"'));
    expect(updates).toHaveLength(1);
    expect(updates[0][0]).not.toContain('emailVerified');
    expect(mocks.clientQuery.mock.calls.some(([sql]) => sql.startsWith('DELETE FROM session'))).toBe(false);
    expect(mocks.clientQuery).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO audit_log'), [admin.id, pending.id, JSON.stringify({ enabled: true, approved: true, role: 'member', canManageSources: false, roleChanged: false })]);
  });

  it.each([0, 3])('deletes and audits all pending accounts together and returns the count %s', async (deleted) => {
    mocks.clientQuery.mockResolvedValue({ rows: [], rowCount: deleted });

    const response = await DELETE(event({ confirm: true }, 'DELETE') as never);

    expect(await response.json()).toEqual({ deleted });
    expect(mocks.transaction).toHaveBeenCalledOnce();
    expect(mocks.clientQuery).toHaveBeenNthCalledWith(1, 'SELECT pg_advisory_xact_lock(782411)');
    expect(mocks.clientQuery).toHaveBeenCalledTimes(2);
    const [sql, values] = mocks.clientQuery.mock.calls[1];
    expect(values).toEqual([admin.id]);
    expect(sql).toContain('DELETE FROM "user" WHERE approved=false AND id<>$1 RETURNING id,username');
    expect(sql).not.toMatch(/emailVerified|enabled|role/);
    expect(sql).toContain('INSERT INTO audit_log(user_id,action,target,details)');
    expect(sql).toContain("SELECT $1,'user.delete',id,jsonb_build_object('username',username) FROM deleted");
  });

  it.each([undefined, false, null, 'true', 1])('rejects pending account deletion without explicit confirmation %j', async (confirm) => {
    await expect(DELETE(event({ confirm }, 'DELETE') as never)).rejects.toMatchObject({ status: 400 });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('refuses pending account deletion without a session', async () => {
    mocks.getSession.mockResolvedValue(null);
    await expect(DELETE(event({ confirm: true }, 'DELETE') as never)).rejects.toMatchObject({ status: 401 });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it.each([member, { ...member, canManageSources: true }, { ...admin, enabled: false }, { ...admin, approved: false }])('refuses pending account deletion to an ineligible account %j', async (user) => {
    mocks.query.mockResolvedValue([user]);
    await expect(DELETE(event({ confirm: true }, 'DELETE') as never)).rejects.toMatchObject({ status: 403 });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('does not report successful pending account deletion when the transaction fails', async () => {
    mocks.clientQuery.mockRejectedValueOnce(new Error('Database unavailable'));
    await expect(DELETE(event({ confirm: true }, 'DELETE') as never)).rejects.toThrow('Database unavailable');
  });
});
