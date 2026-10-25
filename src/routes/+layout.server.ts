import { auth } from '#lib/server/auth.js';
export async function load({ request }: { request: Request }) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return { user: null };
  const u = session.user as typeof session.user & { username?: string; role?: string; enabled?: boolean; approved?: boolean; canManageSources?: boolean };
  return { user: { id: u.id, name: u.name, username: u.username ?? u.name, email: u.email, emailVerified: u.emailVerified, role: u.role ?? 'member', enabled: u.enabled ?? false, approved: u.approved ?? false, canManageSources: u.canManageSources ?? false } };
}
