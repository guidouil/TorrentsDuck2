import { betterAuth } from 'better-auth';
import { APIError, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { deviceAuthorization, username } from 'better-auth/plugins';
import { db, query } from './db';
import { checkPassword, hashPassword, LEGACY_PREFIX } from './passwords';
import { sendResetEmail, sendVerificationEmail } from './mail';
import { audit } from './audit';
import type { Member } from './permissions';

export function validateAuthEnvironment(): void {
  if (process.env.NODE_ENV !== 'production') return;
  const origin = process.env.ORIGIN;
  let url: URL;
  try { url = new URL(origin ?? ''); } catch { throw new Error('Production requires a valid HTTPS ORIGIN'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Production ORIGIN must be an HTTPS origin without a path');
  if (!process.env.BETTER_AUTH_SECRET || process.env.BETTER_AUTH_SECRET.length < 32) throw new Error('BETTER_AUTH_SECRET must contain at least 32 characters');
  if (!process.env.INTERNAL_API_SECRET || process.env.INTERNAL_API_SECRET.length < 32) throw new Error('INTERNAL_API_SECRET must contain at least 32 characters');
  if (process.env.INTERNAL_API_SECRET === process.env.BETTER_AUTH_SECRET) throw new Error('Authentication and internal API secrets must be different');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
}

export async function verifyAndUpgradePassword({ password, hash }: { password: string; hash: string }): Promise<boolean> {
  if (!await checkPassword(password, hash)) return false;
  if (hash.startsWith(LEGACY_PREFIX)) {
    const upgraded = await hashPassword(password);
    // The old hash condition prevents overwriting a concurrent password reset.
    const changed = await query('UPDATE account SET password=$1, "updatedAt"=now() WHERE "providerId"=\'credential\' AND password=$2 RETURNING id', [upgraded, hash]);
    if (!changed.length) return false;
  }
  return true;
}

export async function findByIdentifier(identifier: string): Promise<(Member & { password: string }) | null> {
  if (!identifier || identifier.length > 320) return null;
  const found = await query<Member & { password: string }>(
    `SELECT u.id,u.name,u.username,u.email,u."emailVerified",u.role,u.enabled,u.approved,a.password
     FROM "user" u JOIN account a ON a."userId"=u.id AND a."providerId"='credential'
     WHERE u.username=$1 OR lower(u.email)=lower($1) LIMIT 2`, [identifier]);
  return found.length === 1 ? found[0] : null;
}

export async function verifyCredentials(identifier: string, password: string): Promise<Member | null> {
  const found = await findByIdentifier(identifier);
  if (!found?.enabled || !found.approved || !await verifyAndUpgradePassword({ password, hash: found.password })) return null;
  const { password: _password, ...user } = found;
  return user;
}

export const auth = betterAuth({
  database: db,
  baseURL: process.env.ORIGIN ?? process.env.BETTER_AUTH_URL ?? 'http://localhost:5173',
  secret: process.env.BETTER_AUTH_SECRET,
  emailAndPassword: {
    enabled: true,
    disableSignUp: true,
    minPasswordLength: 12,
    maxPasswordLength: 128,
    revokeSessionsOnPasswordReset: true,
    password: { hash: hashPassword, verify: verifyAndUpgradePassword },
    sendResetPassword: async ({ user, url }) => sendResetEmail(user.email, url),
    onPasswordReset: async ({ user }) => {
      await query('DELETE FROM "deviceCode" WHERE "userId"=$1', [user.id]);
      await audit(user.id, 'user.password-reset');
    }
  },
  emailVerification: {
    sendVerificationEmail: async ({ user, url }) => sendVerificationEmail(user.email, url),
    afterEmailVerification: async (user) => {
      const adminEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase();
      if (adminEmail && user.email.toLowerCase() === adminEmail) {
        await query('UPDATE "user" SET approved=true, "updatedAt"=now() WHERE id=$1 AND lower(email)=$2 AND role=\'admin\' AND "emailVerified"=true', [user.id, adminEmail]);
      }
    }
  },
  session: { expiresIn: 60 * 60 * 24 * 7, cookieCache: { enabled: false } },
  user: {
    additionalFields: {
      role: { type: 'string', defaultValue: 'member', input: false },
      enabled: { type: 'boolean', defaultValue: true, input: false },
      approved: { type: 'boolean', defaultValue: false, input: false },
      legacyId: { type: 'string', required: false, input: false, returned: false }
    }
  },
  plugins: [username({
    minUsernameLength: 1,
    maxUsernameLength: 128,
    usernameNormalization: false,
    displayUsernameNormalization: false,
    usernameValidator: (value) => value.trim().length > 0 && !/[\x00-\x1f\x7f]/.test(value)
  }), deviceAuthorization({
    verificationUri: '/login/device',
    expiresIn: '5m',
    interval: '5s',
    validateClient: (clientId) => clientId === 'torrents-duck-tv'
  })],
  disabledPaths: ['/sign-up/email', '/is-username-available', '/update-user', '/delete-user', '/change-email'],
  databaseHooks: {
    session: { create: { before: async (session, ctx) => {
      const [user] = await query<{ enabled: boolean; approved: boolean }>('SELECT enabled,approved FROM "user" WHERE id=$1', [session.userId]);
      if (!user?.enabled || (ctx?.path === '/device/token' && !user.approved)) throw new APIError('UNAUTHORIZED', { message: 'Invalid credentials' });
      return { data: session };
    } } }
  },
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path === '/device/code') {
        if (ctx.body?.user_id !== undefined || ctx.body?.scope !== undefined) throw new APIError('BAD_REQUEST', { message: 'Unsupported device authorization fields' });
        await query('DELETE FROM "deviceCode" WHERE "expiresAt" < now()');
      }
      if (ctx.path === '/device' || ctx.path === '/device/approve' || ctx.path === '/device/deny') {
        const session = await getSessionFromCtx(ctx);
        if (!session) throw new APIError('UNAUTHORIZED', { message: 'Authentication required' });
        const [user] = await query<{ enabled: boolean; approved: boolean }>('SELECT enabled,approved FROM "user" WHERE id=$1', [session.user.id]);
        if (!user?.enabled || !user.approved) throw new APIError('FORBIDDEN', { message: 'Active approved account required' });
      }
      if (ctx.path === '/sign-in/email' || ctx.path === '/sign-in/username') {
        const identifier = ctx.path === '/sign-in/email' ? ctx.body?.email : ctx.body?.username;
        const user = typeof identifier === 'string' ? await findByIdentifier(identifier) : null;
        if (!user?.enabled) throw new APIError('UNAUTHORIZED', { message: 'Invalid credentials' });
      }
    }),
    after: createAuthMiddleware(async (ctx) => {
      if (ctx.path === '/device/token' && ctx.context.newSession) await setSessionCookie(ctx, ctx.context.newSession);
      const result = ctx.context.returned;
      if (ctx.path === '/change-password' && result && typeof result === 'object' && 'user' in result && ctx.context.session?.user) {
        await query('DELETE FROM "deviceCode" WHERE "userId"=$1', [ctx.context.session.user.id]);
        await audit(ctx.context.session.user.id, 'user.password-change');
      }
    })
  },
  advanced: {
    useSecureCookies: (process.env.ORIGIN ?? process.env.BETTER_AUTH_URL ?? '').startsWith('https://'),
    database: { generateId: () => crypto.randomUUID() }
  }
});

export { requireMember, requireAdmin } from './permissions';
