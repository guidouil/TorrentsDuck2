import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

test('public registration waits for approval and cannot access services', { skip: !process.env.HTTP_BASE_URL }, async () => {
  const base = new URL(process.env.HTTP_BASE_URL);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname), 'This test only runs against a local instance');
  const identifier = `http-test-${randomUUID()}`;
  const password = `Local test password ${randomUUID()}`;
  let createdId;
  let adminCookie = '';
  const request = (path, { cookie = '', body, method = body ? 'POST' : 'GET', origin = base.origin } = {}) => fetch(new URL(path, base), {
    method, redirect: 'manual', headers: { origin, ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined
  });
  const login = async (name, secret) => {
    const response = await request('/api/auth/sign-in/identifier', { body: { identifier: name, password: secret } });
    assert.equal(response.status, 200, 'Login succeeds');
    return response.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
  };
  try {
    const registration = await request('/api/registration', { body: { username: identifier, email: `${identifier}@example.test`, password, role: 'admin', approved: true } });
    assert.equal(registration.status, 201);
    const cookie = await login(identifier, password);
    const session = await (await request('/api/auth/get-session', { cookie })).json();
    createdId = session.user.id;
    assert.equal(session.user.approved, false);
    assert.equal(session.user.role, 'member');
    const home = await request('/', { cookie });
    assert.equal(home.status, 303);
    assert.equal(home.headers.get('location'), '/waiting');
    const waiting = await request('/waiting', { cookie });
    assert.equal(waiting.status, 200);
    const html = await waiting.text();
    assert.ok(html.includes('En attente de validation'));
    assert.ok(!html.includes('href="/files"'));
    for (const path of ['/api/files?space=share&path=', '/api/files/download?space=share&path=x', '/api/torrents', '/api/events', '/api/chat', '/api/files/share', '/api/admin/users']) {
      assert.equal((await request(path, { cookie })).status, 403, `Pending account denied: ${path}`);
    }
    assert.equal((await request('/api/chat', { cookie, body: { body: 'forbidden' } })).status, 403);
    assert.equal((await request('/api/registration', { body: {}, origin: 'https://untrusted.example' })).status, 403);
    adminCookie = await login(process.env.HTTP_ADMIN_LOGIN, process.env.HTTP_ADMIN_PASSWORD);
    const approval = await request('/api/admin/users', { cookie: adminCookie, body: { id: createdId, approved: true } });
    assert.equal(approval.status, 200);
    assert.equal((await request('/api/chat', { cookie })).status, 200, 'The existing session works after approval');
    assert.equal((await request('/waiting', { cookie })).status, 303);
    assert.equal((await request('/api/internal/ftp-auth', { body: { username: identifier, password } })).status, 401);
  } finally {
    if (createdId && adminCookie) {
      assert.equal((await request(`/api/admin/users/${encodeURIComponent(createdId)}`, { method: 'DELETE', cookie: adminCookie, body: { confirm: true } })).status, 200);
    }
  }
});
