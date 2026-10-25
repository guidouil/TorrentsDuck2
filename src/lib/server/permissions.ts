import { error, type RequestEvent } from '@sveltejs/kit';
import { timingSafeEqual } from 'node:crypto';
import { auth } from './auth';
import { query } from './db';

export type Member = {
  id: string;
  name: string;
  username: string;
  email: string;
  emailVerified: boolean;
  role: 'admin' | 'member';
  enabled: boolean;
  approved: boolean;
  canManageSources: boolean;
};

export const memberFields = 'id, name, username, email, "emailVerified", role, enabled, approved, "canManageSources"';

export { readJson as readJsonObject } from './network';

export async function requireMember(event: RequestEvent): Promise<Member> {
  const session = await auth.api.getSession({ headers: event.request.headers, query: { disableCookieCache: true } });
  if (!session) error(401, 'Authentication required');
  const [user] = await query<Member>(`SELECT ${memberFields} FROM "user" WHERE id = $1`, [session.user.id]);
  if (!user?.enabled) error(403, 'Account disabled');
  if (!user.approved) error(403, 'Administrator approval required');
  return user;
}

export async function requireAdmin(event: RequestEvent): Promise<Member> {
  const user = await requireMember(event);
  if (user.role !== 'admin') error(403, 'Administrator access required');
  return user;
}

export async function requireSourceManager(event: RequestEvent): Promise<Member> {
  const user = await requireMember(event);
  if (user.role !== 'admin' && !user.canManageSources) error(403, 'Source management permission required');
  return user;
}

export function requireInternal(request: Request): void {
  const secret = process.env.INTERNAL_API_SECRET;
  const supplied = request.headers.get('authorization') ?? '';
  const expected = `Bearer ${secret}`;
  if (!secret || secret.length < 32 || Buffer.byteLength(supplied) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
    error(401, 'Unauthorized');
  }
}
