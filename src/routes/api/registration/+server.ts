import { error, json } from '@sveltejs/kit';
import { randomUUID } from 'node:crypto';
import { readJsonObject } from '#lib/server/permissions.js';
import { query, transaction } from '#lib/server/db.js';
import { hashPassword } from '#lib/server/passwords.js';
import { rateLimit } from '#lib/server/rate-limit.js';
import { auth } from '#lib/server/auth.js';
import { sendRegistrationEmail } from '#lib/server/mail.js';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async (event) => {
  rateLimit(`registration:${event.getClientAddress()}`, 5);
  const body = await readJsonObject(event.request);
  if (typeof body.username !== 'string' || body.username.length < 1 || body.username.length > 128 || !body.username.trim() || /[\x00-\x1f\x7f]/.test(body.username)) error(400, 'Invalid username');
  if (typeof body.email !== 'string' || body.email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) error(400, 'Invalid email');
  if (typeof body.password !== 'string' || body.password.length < 12 || body.password.length > 128) error(400, 'Use a password between 12 and 128 characters');
  const username = body.username;
  const email = body.email.trim().toLowerCase();
  const isAdmin = email === process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = await hashPassword(body.password);
  const id = randomUUID();
  try {
    await transaction(async (client) => {
      // Registration also reserves cross-field identifiers so sign-in stays unambiguous.
      await client.query('SELECT pg_advisory_xact_lock(782412)');
      const { rows: conflicts } = await client.query('SELECT id FROM "user" WHERE username=$1 OR lower(email)=lower($1) OR lower(username)=$2 OR lower(email)=$2', [username, email]);
      if (conflicts.length) error(409, 'Username or email already registered');
      await client.query('INSERT INTO "user"(id,name,username,"displayUsername",email,role,enabled,approved) VALUES ($1,$2,$2,$2,$3,$4,true,false)', [id, username, email, isAdmin ? 'admin' : 'member']);
      await client.query('INSERT INTO account(id,"accountId","providerId","userId",password) VALUES ($1,$2,\'credential\',$2,$3)', [randomUUID(), id, password]);
      await client.query('INSERT INTO audit_log(user_id,action) VALUES ($1,\'user.register\')', [id]);
    });
  } catch (cause) {
    if (typeof cause === 'object' && cause && 'code' in cause && cause.code === '23505') error(409, 'Username or email already registered');
    throw cause;
  }
  try {
    const admins = await query<{ email: string }>('SELECT email FROM "user" WHERE role=\'admin\' AND enabled=true AND approved=true');
    const recipients = admins.map(({ email }) => email.trim().toLowerCase());
    if (!recipients.length && process.env.ADMIN_EMAIL?.trim()) recipients.push(process.env.ADMIN_EMAIL.trim().toLowerCase());
    const adminURL = new URL('/admin', process.env.ORIGIN ?? process.env.BETTER_AUTH_URL ?? 'http://localhost:5173').href;
    const deliveries = await Promise.allSettled([...new Set(recipients)].map((recipient) => sendRegistrationEmail(recipient, username, email, adminURL)));
    if (deliveries.some(({ status }) => status === 'rejected')) console.error('Failed to notify administrators of a new registration');
  } catch {
    // Registration is already committed; a notification failure must not reject the new account.
    console.error('Failed to notify administrators of a new registration');
  }
  if (isAdmin) {
    try {
      await auth.api.sendVerificationEmail({ body: { email, callbackURL: '/waiting' } });
    } catch {
      return json({ registered: true, verificationEmailSent: false }, { status: 201 });
    }
    return json({ registered: true, verificationEmailSent: true }, { status: 201 });
  }
  return json({ registered: true }, { status: 201 });
};
