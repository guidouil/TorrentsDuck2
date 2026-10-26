import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const mocks = vi.hoisted(() => ({ getSession: vi.fn(), query: vi.fn(), transaction: vi.fn(), clientQuery: vi.fn() }));
vi.mock('../src/lib/server/auth', () => ({ auth: { api: { getSession: mocks.getSession } } }));
vi.mock('../src/lib/server/db', () => ({ query: mocks.query, transaction: mocks.transaction }));

import { GET, POST } from '../src/routes/api/admin/users/+server';

const member = { id: 'member', username: 'Member', role: 'member', enabled: true, approved: true, canManageSources: false };
const admin = { ...member, id: 'admin', role: 'admin' };
function event(body: unknown): RequestEvent {
  return { params: {}, request: new Request('http://localhost/api/admin/users', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) } as unknown as RequestEvent;
}

describe('source management permission administration', () => {
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
});
