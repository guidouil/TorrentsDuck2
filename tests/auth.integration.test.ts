import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { RequestEvent } from '@sveltejs/kit';
import type { Pool } from 'pg';

const mail = vi.hoisted(() => ({ reset: vi.fn().mockResolvedValue(undefined), verify: vi.fn().mockResolvedValue(undefined), registration: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../src/lib/server/mail', () => ({ sendResetEmail: mail.reset, sendVerificationEmail: mail.verify, sendRegistrationEmail: mail.registration }));

describe.skipIf(!process.env.TEST_DATABASE_URL)('authentication with PostgreSQL', () => {
  let db: Pool;
  let authModule: typeof import('../src/lib/server/auth');
  let adminRoutes: typeof import('../src/routes/api/admin/users/+server');
  let registration: typeof import('../src/routes/api/registration/+server');
  let ftpRoute: typeof import('../src/routes/api/internal/ftp-auth/+server');
  const prefix = `auth-test-${randomUUID()}`;
  const adminId = `${prefix}-admin`;
  const memberId = `${prefix}-member`;
  const ftpId = `${prefix}-ftp`;
  const username = `Éric+${prefix}`;
  const email = `${prefix}+member@example.org`;
  const password = 'Mot de passe test 🦆 + 2026';
  const origin = 'http://localhost:5173';
  const configuredAdminEmail = `${prefix}+bootstrap@example.org`;
  const previousAdminEmail = process.env.ADMIN_EMAIL;
  const registeredUsernames = [`${prefix}-public`, `${prefix}-bootstrap`, `${prefix}-mail-failed`];
  let cookie = '';
  let adminCookie = '';
  let pendingId = '';
  let pendingCookie = '';
  let schemaReady = false;
  const deviceCodes: string[] = [];

  function event<Route extends NonNullable<RequestEvent['route']['id']>>(path: Route, body?: unknown, sessionCookie = '', internal = false): RequestEvent<{ id: string }, Route> {
    const headers = new Headers({ origin });
    if (body !== undefined) headers.set('content-type', 'application/json');
    if (sessionCookie) headers.set('cookie', sessionCookie);
    if (internal) headers.set('authorization', `Bearer ${process.env.INTERNAL_API_SECRET}`);
    return {
      request: new Request(`${origin}${path}`, { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) }),
      url: new URL(`${origin}${path}`), params: {}, getClientAddress: () => randomUUID()
    } as unknown as RequestEvent<{ id: string }, Route>;
  }

  async function login(loginEmail: string): Promise<string> {
    const response = await authModule.auth.api.signInEmail({ body: { email: loginEmail, password }, headers: new Headers({ origin }), asResponse: true });
    expect(response.status).toBe(200);
    return response.headers.getSetCookie().map((part) => part.split(';')[0]).join('; ');
  }

  function deviceRequest(path: string, body?: unknown, sessionCookie = ''): Promise<Response> {
    return authModule.auth.handler(new Request(`${origin}/api/auth${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { origin, 'content-type': 'application/json', cookie: sessionCookie },
      body: body === undefined ? undefined : JSON.stringify(body)
    }));
  }

  async function createDevice() {
    const response = await deviceRequest('/device/code', { client_id: 'torrents-duck-tv' });
    expect(response.status).toBe(200);
    const device = await response.json() as { device_code: string; user_code: string; verification_uri: string; verification_uri_complete: string; expires_in: number; interval: number };
    deviceCodes.push(device.device_code);
    return device;
  }

  async function approveDevice(sessionCookie: string) {
    const device = await createDevice();
    expect((await deviceRequest(`/device?user_code=${device.user_code}`, undefined, sessionCookie)).status).toBe(200);
    expect((await deviceRequest('/device/approve', { userCode: device.user_code }, sessionCookie)).status).toBe(200);
    return device;
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    process.env.ORIGIN = origin;
    process.env.BETTER_AUTH_SECRET = randomBytes(48).toString('base64url');
    process.env.INTERNAL_API_SECRET = randomBytes(48).toString('base64url');
    process.env.ADMIN_EMAIL = `  ${configuredAdminEmail.toUpperCase()}  `;
    ({ db } = await import('../src/lib/server/db'));
    await db.query(await readFile(new URL('../db/001-initial.sql', import.meta.url), 'utf8'));
    schemaReady = true;
    const { hashPassword } = await import('../src/lib/server/passwords');
    const hash = await hashPassword(password);
    const legacy = `meteor$${await bcrypt.hash(createHash('sha256').update(password).digest('hex'), 4)}`;
    for (const [id, name, userEmail, role, stored, createdAt] of [
      [adminId, `${prefix}-admin`, `${prefix}+admin@example.org`, 'admin', hash, '2026-01-01'],
      [memberId, username, email, 'member', legacy, '2026-01-03'],
      [ftpId, `${prefix}-ftp`, `${prefix}+ftp@example.org`, 'member', `meteor$${await bcrypt.hash(createHash('sha256').update(password).digest('hex'), 4)}`, '2026-01-02']
    ]) {
      await db.query('INSERT INTO "user"(id,name,username,"displayUsername",email,role,enabled,approved,"createdAt") VALUES ($1,$2,$2,$2,$3,$4,true,true,$5)', [id, name, userEmail, role, createdAt]);
      await db.query('INSERT INTO account(id,"accountId","providerId","userId",password) VALUES ($1,$2,\'credential\',$2,$3)', [randomUUID(), id, stored]);
    }
    authModule = await import('../src/lib/server/auth');
    // Better Auth skips origin checks in test mode unless explicitly restored.
    (await authModule.auth.$context).skipOriginCheck = false;
    adminRoutes = await import('../src/routes/api/admin/users/+server');
    registration = await import('../src/routes/api/registration/+server');
    ftpRoute = await import('../src/routes/api/internal/ftp-auth/+server');
    adminCookie = await login(`${prefix}+admin@example.org`);
  }, 30_000);

  afterAll(async () => {
    if (previousAdminEmail === undefined) delete process.env.ADMIN_EMAIL;
    else process.env.ADMIN_EMAIL = previousAdminEmail;
    if (!db) return;
    try {
      if (schemaReady) {
        await db.query('DELETE FROM "deviceCode" WHERE "deviceCode"=ANY($1::text[])', [deviceCodes]);
        await db.query('DELETE FROM messages WHERE body=$1', [prefix]);
        await db.query('DELETE FROM torrent_authors WHERE hash=$1', [createHash('sha256').update(prefix).digest('hex').slice(0, 40)]);
        await db.query('DELETE FROM audit_log WHERE user_id IN (SELECT id FROM "user" WHERE id=ANY($1::text[]) OR username=ANY($2::text[]))', [[adminId, memberId, ftpId], registeredUsernames]);
        await db.query('DELETE FROM "user" WHERE id=ANY($1::text[]) OR username=ANY($2::text[])', [[adminId, memberId, ftpId], registeredUsernames]);
      }
    } finally {
      await db.end();
    }
  });

  it('upgrades a Meteor hash after username login without marking its email verified', async () => {
    const loginRoute = await import('../src/routes/api/auth/sign-in/identifier/+server');
    const response = await loginRoute.POST(event('/api/auth/sign-in/identifier', { identifier: username, password }));
    expect(response.status).toBe(200);
    cookie = response.headers.getSetCookie().map((part) => part.split(';')[0]).join('; ');
    const { rows: [credential] } = await db.query('SELECT password FROM account WHERE "userId"=$1', [memberId]);
    expect(credential.password).not.toContain('meteor$');
    const user = await authModule.requireMember(event('/api/files', undefined, cookie));
    expect(user.username).toBe(username);
    expect(user.emailVerified).toBe(false);
  });

  it('signs the TV browser in once only after a member explicitly approves its QR code', async () => {
    for (const body of [
      { client_id: 'unknown-client' },
      { client_id: 'torrents-duck-tv', user_id: memberId },
      { client_id: 'torrents-duck-tv', scope: 'admin' }
    ]) expect((await deviceRequest('/device/code', body)).status).toBe(400);
    const device = await createDevice();
    expect(device).toMatchObject({ expires_in: 300, interval: 5, verification_uri: `${origin}/login/device` });
    expect(new URL(device.verification_uri_complete).searchParams.get('user_code')).toBe(device.user_code);
    expect(device.verification_uri_complete).not.toContain(device.device_code);
    expect((await deviceRequest(`/device?user_code=${device.user_code}`)).status).toBe(401);
    expect((await deviceRequest('/device/approve', { userCode: device.user_code })).status).toBe(401);
    const body = { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: device.device_code, client_id: 'torrents-duck-tv' };
    expect(await (await deviceRequest('/device/token', { ...body, device_code: device.user_code })).json()).toMatchObject({ error: 'invalid_grant' });
    expect(await (await deviceRequest('/device/token', { ...body, client_id: 'unknown-client' })).json()).toMatchObject({ error: 'invalid_grant' });
    const waiting = await deviceRequest('/device/token', body);
    expect(waiting.status).toBe(400);
    expect(await waiting.json()).toMatchObject({ error: 'authorization_pending' });
    expect(waiting.headers.getSetCookie()).toEqual([]);
    expect(await (await deviceRequest('/device/token', body)).json()).toMatchObject({ error: 'slow_down' });
    expect((await deviceRequest(`/device?user_code=${device.user_code}`, undefined, cookie)).status).toBe(200);
    expect((await deviceRequest('/device/approve', { userCode: device.user_code }, adminCookie)).status).toBe(403);
    expect((await deviceRequest('/device/approve', { userCode: device.user_code }, cookie)).status).toBe(200);
    await db.query('UPDATE "deviceCode" SET "lastPolledAt"=NULL WHERE "deviceCode"=$1', [device.device_code]);
    const foreignOrigin = await authModule.auth.handler(new Request(`${origin}/api/auth/device/token`, {
      method: 'POST', headers: { origin: 'https://untrusted.example.org', 'content-type': 'application/json', cookie }, body: JSON.stringify(body)
    }));
    expect(foreignOrigin.status).toBe(403);
    expect(foreignOrigin.headers.getSetCookie()).toEqual([]);
    const responses = await Promise.all([deviceRequest('/device/token', body), deviceRequest('/device/token', body)]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 400]);
    const success = responses.find((response) => response.status === 200)!;
    expect(success.headers.getSetCookie().join(';')).toContain('HttpOnly');
    const tvCookie = success.headers.getSetCookie().map((part) => part.split(';')[0]).join('; ');
    expect((await authModule.requireMember(event('/api/files', undefined, tvCookie))).id).toBe(memberId);
    expect((await deviceRequest('/device/token', body)).status).toBe(400);
  });

  it('refuses QR approval and session creation when member access is withdrawn', async () => {
    const device = await createDevice();
    try {
      await db.query('UPDATE "user" SET enabled=false WHERE id=$1', [memberId]);
      expect((await deviceRequest(`/device?user_code=${device.user_code}`, undefined, cookie)).status).toBe(403);
      await db.query('UPDATE "user" SET enabled=true,approved=false WHERE id=$1', [memberId]);
      expect((await deviceRequest(`/device?user_code=${device.user_code}`, undefined, cookie)).status).toBe(403);
      for (const path of ['/device/approve', '/device/deny']) {
        expect((await deviceRequest(path, { userCode: device.user_code }, cookie)).status).toBe(403);
      }
      await db.query('UPDATE "user" SET enabled=true,approved=true WHERE id=$1', [memberId]);
      expect((await deviceRequest(`/device?user_code=${device.user_code}`, undefined, cookie)).status).toBe(200);
      expect((await deviceRequest('/device/approve', { userCode: device.user_code }, cookie)).status).toBe(200);
      await db.query('UPDATE "user" SET approved=false WHERE id=$1', [memberId]);
      const before = await db.query('SELECT count(*)::integer AS count FROM session WHERE "userId"=$1', [memberId]);
      const response = await deviceRequest('/device/token', { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: device.device_code, client_id: 'torrents-duck-tv' });
      expect(response.status).toBe(401);
      expect(response.headers.getSetCookie()).toEqual([]);
      expect((await db.query('SELECT count(*)::integer AS count FROM session WHERE "userId"=$1', [memberId])).rows).toEqual(before.rows);
    } finally {
      await db.query('UPDATE "user" SET enabled=true,approved=true WHERE id=$1', [memberId]);
    }
  });

  it('rejects denied and expired QR codes and cleans expired requests on issuance', async () => {
    const denied = await createDevice();
    expect((await deviceRequest(`/device?user_code=${denied.user_code}`, undefined, cookie)).status).toBe(200);
    expect((await deviceRequest('/device/deny', { userCode: denied.user_code }, cookie)).status).toBe(200);
    const response = await deviceRequest('/device/token', { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: denied.device_code, client_id: 'torrents-duck-tv' });
    expect(await response.json()).toMatchObject({ error: 'access_denied' });
    expect(response.headers.getSetCookie()).toEqual([]);
    const expired = await createDevice();
    await db.query('UPDATE "deviceCode" SET "expiresAt"=now()-interval \'1 second\' WHERE "deviceCode"=$1', [expired.device_code]);
    expect((await deviceRequest(`/device?user_code=${expired.user_code}`, undefined, cookie)).status).toBe(400);
    expect((await deviceRequest('/device/approve', { userCode: expired.user_code }, cookie)).status).toBe(400);
    await createDevice();
    expect((await db.query('SELECT id FROM "deviceCode" WHERE "deviceCode"=$1', [expired.device_code])).rows).toEqual([]);
  });

  it('signs out every password and TV session without affecting another account', async () => {
    const originalCookie = cookie;
    const secondCookie = await login(email);
    const tvDevice = await approveDevice(cookie);
    const tvResponse = await deviceRequest('/device/token', { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: tvDevice.device_code, client_id: 'torrents-duck-tv' });
    expect(tvResponse.status).toBe(200);
    const tvCookie = tvResponse.headers.getSetCookie().map((part) => part.split(';')[0]).join('; ');
    expect((await authModule.requireMember(event('/api/files', undefined, tvCookie))).id).toBe(memberId);
    const unusedDevice = await approveDevice(cookie);
    const otherDevice = await approveDevice(adminCookie);
    try {
      const foreignOrigin = await authModule.auth.handler(new Request(`${origin}/api/auth/sign-out`, {
        method: 'POST', headers: { origin: 'https://untrusted.example.org', 'content-type': 'application/json', cookie }, body: '{}'
      }));
      expect(foreignOrigin.status).toBe(403);
      expect((await authModule.requireMember(event('/api/files', undefined, secondCookie))).id).toBe(memberId);
      const response = await deviceRequest('/sign-out', {}, cookie);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ success: true });
      expect(response.headers.getSetCookie().join(';')).toContain('Max-Age=0');
      for (const sessionCookie of [cookie, secondCookie, tvCookie]) {
        await expect(authModule.requireMember(event('/api/files', undefined, sessionCookie))).rejects.toMatchObject({ status: 401 });
      }
      expect((await db.query('SELECT id FROM session WHERE "userId"=$1', [memberId])).rows).toEqual([]);
      expect((await db.query('SELECT id FROM "deviceCode" WHERE "userId"=$1', [memberId])).rows).toEqual([]);
      expect(await (await deviceRequest('/device/token', { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: unusedDevice.device_code, client_id: 'torrents-duck-tv' })).json()).toMatchObject({ error: 'invalid_grant' });
      expect((await authModule.requireAdmin(event('/api/admin/users', undefined, adminCookie))).id).toBe(adminId);
      expect((await db.query('SELECT id FROM "deviceCode" WHERE "deviceCode"=$1', [otherDevice.device_code])).rows).toHaveLength(1);
    } finally {
      cookie = await login(email);
    }
    for (const staleCookie of ['', originalCookie]) expect((await deviceRequest('/sign-out', {}, staleCookie)).status).toBe(200);
    expect((await authModule.requireMember(event('/api/files', undefined, cookie))).id).toBe(memberId);
    expect((await authModule.requireAdmin(event('/api/admin/users', undefined, adminCookie))).id).toBe(adminId);
  });

  it('uses the same legacy upgrade over private FTPS authentication and rejects the wrong secret', async () => {
    await expect(ftpRoute.POST(event('/api/internal/ftp-auth', { username: `${prefix}-ftp`, password }))).rejects.toMatchObject({ status: 401 });
    const response = await ftpRoute.POST(event('/api/internal/ftp-auth', { username: `${prefix}-ftp`, password }, '', true));
    expect(await response.json()).toEqual({ authorized: true });
    const { rows: [credential] } = await db.query('SELECT password FROM account WHERE "userId"=$1', [ftpId]);
    expect(credential.password).not.toContain('meteor$');
  });

  it('blocks native Better Auth signup and member administration without leaking account secrets', async () => {
    const denied = await authModule.auth.handler(new Request(`${origin}/api/auth/sign-up/email`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'intruder', email: `${prefix}+intruder@example.org`, password }) }));
    expect(denied.status).toBeGreaterThanOrEqual(400);
    await expect(adminRoutes.GET(event('/api/admin/users', undefined, cookie))).rejects.toMatchObject({ status: 403 });
    const response = await adminRoutes.GET(event('/api/admin/users', undefined, adminCookie));
    const { users } = await response.json();
    expect(users.find((user: { id: string }) => user.id === memberId)).not.toHaveProperty('password');
    expect(users.find((user: { id: string }) => user.id === memberId)).not.toHaveProperty('legacyId');
  });

  it('lists accounts from newest to oldest', async () => {
    const { users } = await (await adminRoutes.GET(event('/api/admin/users', undefined, adminCookie))).json();
    expect(users.filter((user: { id: string }) => [adminId, memberId, ftpId].includes(user.id)).map((user: { id: string }) => user.id)).toEqual([memberId, ftpId, adminId]);
  });

  it('delegates source management without account administration and revokes it on the same session', async () => {
    expect((await authModule.requireMember(event('/api/torrents', undefined, cookie))).canManageSources).toBe(false);
    const granted = await adminRoutes.POST(event('/api/admin/users', { id: memberId, canManageSources: true }, adminCookie));
    expect((await granted.json()).user).toMatchObject({ role: 'member', canManageSources: true });
    try {
      expect((await authModule.requireSourceManager(event('/api/torrents', undefined, cookie))).id).toBe(memberId);
      const session = await authModule.auth.api.getSession({ headers: new Headers({ cookie }), query: { disableCookieCache: true } });
      expect(session?.user.canManageSources).toBe(true);
      await expect(adminRoutes.POST(event('/api/admin/users', { id: memberId, role: 'admin' }, cookie))).rejects.toMatchObject({ status: 403 });
    } finally {
      await adminRoutes.POST(event('/api/admin/users', { id: memberId, canManageSources: false }, adminCookie));
    }
    await expect(authModule.requireSourceManager(event('/api/torrents', undefined, cookie))).rejects.toMatchObject({ status: 403 });
    expect((await authModule.requireMember(event('/api/torrents', undefined, cookie))).id).toBe(memberId);
  });

  it('allows registration and login while refusing all services before approval', async () => {
    const body = { username: `${prefix}-public`, email: `${prefix}+public@example.org`, password, role: 'admin', approved: true, enabled: false, canManageSources: true };
    const registered = await registration.POST(event('/api/registration', body));
    expect(registered.status).toBe(201);
    expect(mail.registration).toHaveBeenCalledWith(`${prefix}+admin@example.org`, body.username, body.email, `${origin}/admin`);
    const { rows: [user] } = await db.query('SELECT id,role,enabled,approved,"canManageSources","emailVerified" FROM "user" WHERE username=$1', [body.username]);
    pendingId = user.id;
    expect(user).toMatchObject({ role: 'member', enabled: true, approved: false, canManageSources: false, emailVerified: false });
    pendingCookie = await login(body.email);
    const session = await authModule.auth.api.getSession({ headers: new Headers({ cookie: pendingCookie }) });
    expect(session?.user.id).toBe(pendingId);
    expect(session?.user.approved).toBe(false);
    await expect(authModule.requireMember(event('/api/files', undefined, pendingCookie))).rejects.toMatchObject({ status: 403 });
    await expect(adminRoutes.POST(event('/api/admin/users', { id: pendingId, approved: true }, pendingCookie))).rejects.toMatchObject({ status: 403 });
    const files = await import('../src/routes/api/files/+server');
    const downloads = await import('../src/routes/api/files/download/+server');
    const torrents = await import('../src/routes/api/torrents/+server');
    const events = await import('../src/routes/api/events/+server');
    const chat = await import('../src/routes/api/chat/+server');
    const sharing = await import('../src/routes/api/files/share/+server');
    for (const request of [
      () => files.GET(event('/api/files', undefined, pendingCookie)),
      () => downloads.GET(event('/api/files/download', undefined, pendingCookie)),
      () => torrents.GET(event('/api/torrents', undefined, pendingCookie)),
      () => events.GET(event('/api/events', undefined, pendingCookie)),
      () => chat.GET(event('/api/chat', undefined, pendingCookie)),
      () => sharing.GET(event('/api/files/share', undefined, pendingCookie)),
      () => adminRoutes.GET(event('/api/admin/users', undefined, pendingCookie))
    ]) await expect(request()).rejects.toMatchObject({ status: 403 });
    await expect(ftpRoute.POST(event('/api/internal/ftp-auth', { username: body.username, password }, '', true))).rejects.toMatchObject({ status: 401 });
    expect(await authModule.verifyCredentials(body.username, password)).toBeNull();
  });

  it('also signs out all sessions for an account awaiting approval', async () => {
    const secondCookie = await login(`${prefix}+public@example.org`);
    try {
      expect((await deviceRequest('/sign-out', {}, secondCookie)).status).toBe(200);
      for (const sessionCookie of [pendingCookie, secondCookie]) {
        expect(await authModule.auth.api.getSession({ headers: new Headers({ cookie: sessionCookie }) })).toBeNull();
      }
      expect((await db.query('SELECT id FROM session WHERE "userId"=$1', [pendingId])).rows).toEqual([]);
      expect((await authModule.requireAdmin(event('/api/admin/users', undefined, adminCookie))).id).toBe(adminId);
    } finally {
      pendingCookie = await login(`${prefix}+public@example.org`);
    }
  });

  it('rejects duplicate registration identities without creating more accounts', async () => {
    await expect(registration.POST(event('/api/registration', { username: `${prefix}-public`, email: `${prefix}+other@example.org`, password }))).rejects.toMatchObject({ status: 409 });
    await expect(registration.POST(event('/api/registration', { username: `${prefix}-other`, email: `${prefix}+PUBLIC@EXAMPLE.ORG`, password }))).rejects.toMatchObject({ status: 409 });
    await expect(registration.POST(event('/api/registration', { username: `${prefix}+public@example.org`, email: `${prefix}+other@example.org`, password }))).rejects.toMatchObject({ status: 409 });
    expect((await db.query('SELECT id FROM "user" WHERE id=$1', [pendingId])).rows).toHaveLength(1);
  });

  it('does not approve or promote an ordinary member after email verification', async () => {
    const userEmail = `${prefix}+public@example.org`;
    const previous = process.env.ADMIN_EMAIL;
    process.env.ADMIN_EMAIL = userEmail;
    try {
      await authModule.auth.api.sendVerificationEmail({ body: { email: userEmail } });
      const verificationUrl = new URL(mail.verify.mock.calls.at(-1)![1]);
      const token = verificationUrl.searchParams.get('token')!;
      expect((await authModule.auth.handler(new Request(`${origin}/api/auth/verify-email?token=${encodeURIComponent(token)}`))).status).toBe(200);
      const { rows: [user] } = await db.query('SELECT role,approved,"emailVerified" FROM "user" WHERE id=$1', [pendingId]);
      expect(user).toEqual({ role: 'member', approved: false, emailVerified: true });
      await expect(authModule.requireAdmin(event('/api/admin/users', undefined, pendingCookie))).rejects.toMatchObject({ status: 403 });
    } finally {
      process.env.ADMIN_EMAIL = previous;
    }
  });

  it('grants the configured new administrator access only after a valid signed email verification', async () => {
    const body = { username: `${prefix}-bootstrap`, email: configuredAdminEmail.toUpperCase(), password, approved: true };
    const response = await registration.POST(event('/api/registration', body));
    expect(await response.json()).toEqual({ registered: true, verificationEmailSent: true });
    expect(mail.verify.mock.calls.at(-1)![0]).toBe(configuredAdminEmail);
    const { rows: [created] } = await db.query('SELECT id,role,approved,"emailVerified" FROM "user" WHERE email=$1', [configuredAdminEmail]);
    expect(created).toMatchObject({ role: 'admin', approved: false, emailVerified: false });
    const bootstrapCookie = await login(configuredAdminEmail);
    await expect(authModule.requireAdmin(event('/api/admin/users', undefined, bootstrapCookie))).rejects.toMatchObject({ status: 403 });
    expect(await authModule.verifyCredentials(configuredAdminEmail, password)).toBeNull();

    const verificationUrl = new URL(mail.verify.mock.calls.at(-1)![1]);
    expect(verificationUrl.searchParams.get('callbackURL')).toBe('/waiting');
    const token = verificationUrl.searchParams.get('token')!;
    const invalid = await authModule.auth.handler(new Request(`${origin}/api/auth/verify-email?token=${encodeURIComponent(`${token}invalid`)}`));
    expect(invalid.status).toBeGreaterThanOrEqual(400);
    expect((await db.query('SELECT approved FROM "user" WHERE id=$1', [created.id])).rows[0].approved).toBe(false);
    expect((await authModule.auth.handler(new Request(verificationUrl))).status).toBe(302);
    expect((await authModule.requireAdmin(event('/api/admin/users', undefined, bootstrapCookie))).id).toBe(created.id);
    expect((await authModule.verifyCredentials(configuredAdminEmail, password))?.role).toBe('admin');
    await db.query('UPDATE "user" SET enabled=false WHERE id=$1', [created.id]);
  });

  it('preserves the new configured administrator when email delivery fails', async () => {
    const previous = process.env.ADMIN_EMAIL;
    const userEmail = `${prefix}+mail-failed@example.org`;
    process.env.ADMIN_EMAIL = userEmail;
    mail.verify.mockRejectedValueOnce(new Error('Mail delivery unavailable'));
    try {
      const response = await registration.POST(event('/api/registration', { username: `${prefix}-mail-failed`, email: userEmail, password }));
      expect(response.status).toBe(201);
      expect(await response.json()).toEqual({ registered: true, verificationEmailSent: false });
      expect((await db.query('SELECT role,approved,"emailVerified" FROM "user" WHERE email=$1', [userEmail])).rows).toEqual([{ role: 'admin', approved: false, emailVerified: false }]);
      const sessionCookie = await login(userEmail);
      await expect(authModule.requireAdmin(event('/api/admin/users', undefined, sessionCookie))).rejects.toMatchObject({ status: 403 });
    } finally {
      process.env.ADMIN_EMAIL = previous;
    }
  });

  it('grants access to the same session only after administrator approval', async () => {
    const response = await adminRoutes.POST(event('/api/admin/users', { id: pendingId, approved: true }, adminCookie));
    expect((await response.json()).user.approved).toBe(true);
    const session = await authModule.auth.api.getSession({ headers: new Headers({ cookie: pendingCookie }), query: { disableCookieCache: true } });
    expect(session?.user.approved).toBe(true);
    expect((await authModule.requireMember(event('/api/files', undefined, pendingCookie))).id).toBe(pendingId);
    expect((await authModule.verifyCredentials(`${prefix}-public`, password))?.id).toBe(pendingId);
    const list = await (await adminRoutes.GET(event('/api/admin/users', undefined, adminCookie))).json();
    expect(list.users.find((user: { id: string }) => user.id === pendingId).approved).toBe(true);
  });

  it('revokes web sessions, playback and FTPS when approval is withdrawn', async () => {
    const policyRoute = await import('../src/routes/api/internal/ftp-policy/+server');
    const before = await (await policyRoute.GET(event('/api/internal/ftp-policy', undefined, '', true))).json();
    const token = randomBytes(32).toString('base64url');
    const device = await approveDevice(pendingCookie);
    await db.query('INSERT INTO playback_tokens(token_hash,user_id,space,path,expires_at) VALUES ($1,$2,\'downloads\',\'test.mp4\',now()+interval \'1 day\')', [createHash('sha256').update(token).digest('hex'), pendingId]);
    const response = await adminRoutes.POST(event('/api/admin/users', { id: pendingId, approved: false }, adminCookie));
    expect((await response.json()).user).toMatchObject({ enabled: true, approved: false });
    expect(await (await deviceRequest('/device/token', { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: device.device_code, client_id: 'torrents-duck-tv' })).json()).toMatchObject({ error: 'invalid_grant' });
    await expect(authModule.requireMember(event('/api/files', undefined, pendingCookie))).rejects.toMatchObject({ status: 401 });
    pendingCookie = await login(`${prefix}+public@example.org`);
    await expect(authModule.requireMember(event('/api/files', undefined, pendingCookie))).rejects.toMatchObject({ status: 403 });
    expect(await authModule.verifyCredentials(`${prefix}-public`, password)).toBeNull();
    const { playbackFile } = await import('../src/lib/server/playback');
    await expect(playbackFile(token)).rejects.toMatchObject({ status: 404 });
    const { rows: [link] } = await db.query('SELECT revoked_at FROM playback_tokens WHERE user_id=$1', [pendingId]);
    expect(link.revoked_at).not.toBeNull();
    const after = await (await policyRoute.GET(event('/api/internal/ftp-policy', undefined, '', true))).json();
    expect(BigInt(after.revision)).toBeGreaterThan(BigInt(before.revision));
    await expect(adminRoutes.POST(event('/api/admin/users', { id: adminId, approved: false }, adminCookie))).rejects.toMatchObject({ status: 400 });
  });

  it('resets a password, revokes existing sessions and spends the reset token once', async () => {
    const policyRoute = await import('../src/routes/api/internal/ftp-policy/+server');
    const before = await (await policyRoute.GET(event('/api/internal/ftp-policy', undefined, '', true))).json();
    const device = await approveDevice(cookie);
    await authModule.auth.api.requestPasswordReset({ body: { email, redirectTo: `${origin}/reset-password` }, headers: new Headers({ origin }) });
    expect(mail.reset).toHaveBeenCalled();
    const resetUrl = new URL(mail.reset.mock.calls.at(-1)![1]);
    const token = resetUrl.pathname.split('/').at(-1)!;
    const newPassword = 'Un autre mot de passe 🦆 2026';
    await authModule.auth.api.resetPassword({ body: { token, newPassword } });
    expect(await (await deviceRequest('/device/token', { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: device.device_code, client_id: 'torrents-duck-tv' })).json()).toMatchObject({ error: 'invalid_grant' });
    expect(await authModule.verifyCredentials(email, password)).toBeNull();
    expect((await authModule.verifyCredentials(email, newPassword))?.id).toBe(memberId);
    await expect(authModule.requireMember(event('/api/files', undefined, cookie))).rejects.toMatchObject({ status: 401 });
    await expect(authModule.auth.api.resetPassword({ body: { token, newPassword: password } })).rejects.toBeDefined();
    const after = await (await policyRoute.GET(event('/api/internal/ftp-policy', undefined, '', true))).json();
    expect(BigInt(after.revision)).toBeGreaterThan(BigInt(before.revision));
  });

  it('records native password changes for FTPS connection revocation', async () => {
    const policyRoute = await import('../src/routes/api/internal/ftp-policy/+server');
    const before = await (await policyRoute.GET(event('/api/internal/ftp-policy', undefined, '', true))).json();
    const replacement = 'Nouveau mot de passe admin 🦆';
    const device = await approveDevice(adminCookie);
    await expect(authModule.auth.api.changePassword({ body: { currentPassword: 'wrong', newPassword: replacement }, headers: new Headers({ origin, cookie: adminCookie }) })).rejects.toBeDefined();
    expect((await db.query('SELECT id FROM "deviceCode" WHERE "deviceCode"=$1', [device.device_code])).rows).toHaveLength(1);
    await authModule.auth.api.changePassword({ body: { currentPassword: password, newPassword: replacement, revokeOtherSessions: false }, headers: new Headers({ origin, cookie: adminCookie }) });
    expect(await (await deviceRequest('/device/token', { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: device.device_code, client_id: 'torrents-duck-tv' })).json()).toMatchObject({ error: 'invalid_grant' });
    expect(await authModule.verifyCredentials(`${prefix}+admin@example.org`, password)).toBeNull();
    expect((await authModule.verifyCredentials(`${prefix}+admin@example.org`, replacement))?.id).toBe(adminId);
    const after = await (await policyRoute.GET(event('/api/internal/ftp-policy', undefined, '', true))).json();
    expect(BigInt(after.revision)).toBeGreaterThan(BigInt(before.revision));
  });

  it('disables access immediately for web, FTPS and temporary playback links', async () => {
    const device = await approveDevice(await login(`${prefix}+ftp@example.org`));
    await db.query('INSERT INTO playback_tokens(token_hash,user_id,space,path,expires_at) VALUES ($1,$2,\'downloads\',\'test.mp4\',now()+interval \'1 day\')', [createHash('sha256').update(prefix).digest('hex'), ftpId]);
    const response = await adminRoutes.POST(event('/api/admin/users', { id: ftpId, enabled: false }, adminCookie));
    expect(response.status).toBe(200);
    expect(await (await deviceRequest('/device/token', { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: device.device_code, client_id: 'torrents-duck-tv' })).json()).toMatchObject({ error: 'invalid_grant' });
    expect(await authModule.verifyCredentials(`${prefix}-ftp`, password)).toBeNull();
    await expect(ftpRoute.POST(event('/api/internal/ftp-auth', { username: `${prefix}-ftp`, password }, '', true))).rejects.toMatchObject({ status: 401 });
    const { rows: [link] } = await db.query('SELECT revoked_at FROM playback_tokens WHERE user_id=$1', [ftpId]);
    expect(link.revoked_at).not.toBeNull();
    await expect(adminRoutes.POST(event('/api/admin/users', { id: adminId, enabled: false }, adminCookie))).rejects.toMatchObject({ status: 400 });
  });

  it('deletes an account only after explicit confirmation and preserves community content', async () => {
    const deleteRoute = await import('../src/routes/api/admin/users/[id]/+server');
    const policyRoute = await import('../src/routes/api/internal/ftp-policy/+server');
    const before = await (await policyRoute.GET(event('/api/internal/ftp-policy', undefined, '', true))).json();
    await db.query('INSERT INTO messages(user_id,body) VALUES ($1,$2)', [ftpId, prefix]);
    await db.query('INSERT INTO torrent_authors(hash,user_id) VALUES ($1,$2)', [createHash('sha256').update(prefix).digest('hex').slice(0, 40), ftpId]);
    const unconfirmed = event('/api/admin/users/[id]', { confirm: false }, adminCookie);
    unconfirmed.params.id = ftpId;
    await expect(deleteRoute.DELETE(unconfirmed)).rejects.toMatchObject({ status: 400 });
    const deletion = event('/api/admin/users/[id]', { confirm: true }, adminCookie);
    deletion.params.id = ftpId;
    expect((await deleteRoute.DELETE(deletion)).status).toBe(200);
    expect((await db.query('SELECT id FROM "user" WHERE id=$1', [ftpId])).rows).toHaveLength(0);
    expect((await db.query('SELECT user_id FROM messages WHERE body=$1', [prefix])).rows).toEqual([{ user_id: null }]);
    expect((await db.query('SELECT user_id FROM torrent_authors WHERE hash=$1', [createHash('sha256').update(prefix).digest('hex').slice(0, 40)])).rows).toEqual([{ user_id: null }]);
    expect((await db.query('SELECT id FROM playback_tokens WHERE user_id=$1', [ftpId])).rows).toHaveLength(0);
    const after = await (await policyRoute.GET(event('/api/internal/ftp-policy', undefined, '', true))).json();
    expect(BigInt(after.revision)).toBeGreaterThan(BigInt(before.revision));
    const self = event('/api/admin/users/[id]', { confirm: true }, adminCookie);
    self.params.id = adminId;
    await expect(deleteRoute.DELETE(self)).rejects.toMatchObject({ status: 400 });
  });

  it('rejects incomplete production authentication configuration before serving', () => {
    const previous = { NODE_ENV: process.env.NODE_ENV, ORIGIN: process.env.ORIGIN, BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET, INTERNAL_API_SECRET: process.env.INTERNAL_API_SECRET };
    try {
      process.env.NODE_ENV = 'production';
      process.env.ORIGIN = 'http://example.org';
      expect(() => authModule.validateAuthEnvironment()).toThrow('HTTPS');
      process.env.ORIGIN = 'https://example.org';
      process.env.BETTER_AUTH_SECRET = 'short';
      expect(() => authModule.validateAuthEnvironment()).toThrow('BETTER_AUTH_SECRET');
      process.env.BETTER_AUTH_SECRET = randomBytes(32).toString('hex');
      process.env.INTERNAL_API_SECRET = process.env.BETTER_AUTH_SECRET;
      expect(() => authModule.validateAuthEnvironment()).toThrow('different');
      process.env.INTERNAL_API_SECRET = randomBytes(32).toString('hex');
      expect(() => authModule.validateAuthEnvironment()).not.toThrow();
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
