import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const mocks = vi.hoisted(() => ({ query: vi.fn(), admins: vi.fn(), transaction: vi.fn(), sendVerificationEmail: vi.fn(), sendRegistrationEmail: vi.fn() }));
vi.mock('../src/lib/server/db', () => ({ query: mocks.admins, transaction: mocks.transaction }));
vi.mock('../src/lib/server/auth', () => ({ auth: { api: { sendVerificationEmail: mocks.sendVerificationEmail } } }));
vi.mock('../src/lib/server/mail', () => ({ sendRegistrationEmail: mocks.sendRegistrationEmail }));
vi.mock('../src/lib/server/permissions', () => ({ readJsonObject: (request: Request) => request.json() }));
vi.mock('../src/lib/server/passwords', () => ({ hashPassword: vi.fn().mockResolvedValue('password-hash') }));
vi.mock('../src/lib/server/rate-limit', () => ({ rateLimit: vi.fn() }));

import { POST } from '../src/routes/api/registration/+server';

const body = { username: 'TestAdmin', email: 'admin@example.com', password: 'a-long-test-password', role: 'admin', approved: true, canManageSources: true };

function event(value: unknown = body): RequestEvent<Record<string, never>, '/api/registration'> {
  return {
    request: new Request('http://localhost/api/registration', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) }),
    getClientAddress: () => 'registration-test'
  } as RequestEvent<Record<string, never>, '/api/registration'>;
}

function insertedUser() {
  return mocks.query.mock.calls.find(([sql]) => sql.startsWith('INSERT INTO "user"'));
}

describe('public registration administrator configuration', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('ADMIN_EMAIL', 'admin@example.com');
    vi.stubEnv('ORIGIN', 'https://duck.example.org');
    vi.stubEnv('BETTER_AUTH_URL', 'https://other.example.org');
    mocks.query.mockResolvedValue({ rows: [] });
    mocks.admins.mockResolvedValue([]);
    mocks.transaction.mockImplementation(async (callback) => callback({ query: mocks.query }));
    mocks.sendVerificationEmail.mockResolvedValue({ status: true });
    mocks.sendRegistrationEmail.mockResolvedValue(undefined);
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it('reserves the configured administrator role but requires email verification before approval', async () => {
    vi.stubEnv('ADMIN_EMAIL', '  ADMIN@EXAMPLE.COM  ');
    const response = await POST(event({ ...body, email: 'ADMIN@example.com' }));
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ registered: true, verificationEmailSent: true });
    expect(insertedUser()).toEqual([
      expect.stringContaining('$4,true,false)'),
      [expect.any(String), body.username, body.email, 'admin']
    ]);
    expect(mocks.sendVerificationEmail).toHaveBeenCalledWith({ body: { email: body.email, callbackURL: '/waiting' } });
    expect(mocks.transaction.mock.invocationCallOrder[0]).toBeLessThan(mocks.sendVerificationEmail.mock.invocationCallOrder[0]);
  });

  it.each([undefined, '', 'someone-else@example.org'])('ignores submitted role, approval and source permissions when ADMIN_EMAIL is %s', async (adminEmail) => {
    vi.stubEnv('ADMIN_EMAIL', adminEmail);
    const response = await POST(event());
    expect(await response.json()).toEqual({ registered: true });
    expect(insertedUser()?.[1]).toEqual([expect.any(String), body.username, body.email, 'member']);
    expect(insertedUser()?.[0]).not.toContain('canManageSources');
    expect(mocks.sendVerificationEmail).not.toHaveBeenCalled();
  });

  it('keeps the account registered when verification delivery fails', async () => {
    mocks.sendVerificationEmail.mockRejectedValue(new Error('Mail service unavailable'));
    const response = await POST(event());
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ registered: true, verificationEmailSent: false });
    expect(insertedUser()?.[1]).toContain('admin');
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO account'), expect.any(Array));
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO audit_log'), expect.any(Array));
  });

  it('does not send a verification email when the registration transaction fails', async () => {
    mocks.transaction.mockRejectedValue({ code: '23505' });
    await expect(POST(event())).rejects.toMatchObject({ status: 409 });
    expect(mocks.sendVerificationEmail).not.toHaveBeenCalled();
    expect(mocks.sendRegistrationEmail).not.toHaveBeenCalled();
    expect(mocks.admins).not.toHaveBeenCalled();
  });

  it('notifies active approved administrators once with the configured administration URL', async () => {
    mocks.admins.mockResolvedValue([{ email: ' FIRST@EXAMPLE.ORG ' }, { email: 'first@example.org' }, { email: 'second@example.org' }]);
    const response = await POST(event({ ...body, email: 'new@example.org' }));
    expect(response.status).toBe(201);
    expect(mocks.admins).toHaveBeenCalledWith(expect.stringContaining("WHERE role='admin' AND enabled=true AND approved=true"));
    expect(mocks.sendRegistrationEmail.mock.calls).toEqual([
      ['first@example.org', body.username, 'new@example.org', 'https://duck.example.org/admin'],
      ['second@example.org', body.username, 'new@example.org', 'https://duck.example.org/admin']
    ]);
  });

  it('uses ADMIN_EMAIL when no approved administrator exists', async () => {
    vi.stubEnv('ADMIN_EMAIL', '  ADMIN@EXAMPLE.COM  ');
    await POST(event({ ...body, email: 'new@example.org' }));
    expect(mocks.sendRegistrationEmail).toHaveBeenCalledExactlyOnceWith('admin@example.com', body.username, 'new@example.org', 'https://duck.example.org/admin');
  });

  it('does not send a notification without any configured recipient', async () => {
    vi.stubEnv('ADMIN_EMAIL', '');
    await POST(event());
    expect(mocks.sendRegistrationEmail).not.toHaveBeenCalled();
  });

  it('waits until registration commits before notifying administrators', async () => {
    let commit!: () => void;
    mocks.transaction.mockReturnValue(new Promise<void>((resolve) => { commit = resolve; }));
    const registered = POST(event());
    await vi.waitFor(() => expect(mocks.transaction).toHaveBeenCalled());
    expect(mocks.sendRegistrationEmail).not.toHaveBeenCalled();
    commit();
    await registered;
    expect(mocks.sendRegistrationEmail).toHaveBeenCalledOnce();
  });

  it('preserves registration and attempts other recipients when one notification fails', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.admins.mockResolvedValue([{ email: 'first@example.org' }, { email: 'second@example.org' }]);
    mocks.sendRegistrationEmail.mockRejectedValueOnce(new Error('Private SMTP details'));
    const response = await POST(event());
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ registered: true, verificationEmailSent: true });
    expect(mocks.sendRegistrationEmail).toHaveBeenCalledTimes(2);
    expect(mocks.sendVerificationEmail).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledExactlyOnceWith('Failed to notify administrators of a new registration');
  });

  it('keeps a committed registration when looking up notification recipients fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.admins.mockRejectedValueOnce(new Error('Database temporarily unavailable'));
    const response = await POST(event({ ...body, email: 'new@example.org' }));
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ registered: true });
    expect(mocks.sendRegistrationEmail).not.toHaveBeenCalled();
  });
});
