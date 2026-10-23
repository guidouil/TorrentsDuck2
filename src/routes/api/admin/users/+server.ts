import { error, json } from '@sveltejs/kit';
import { readJsonObject, requireAdmin } from '#lib/server/permissions.js';
import { query, transaction } from '#lib/server/db.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async (event) => {
  await requireAdmin(event);
  const users = await query('SELECT id, username, email, role, enabled, approved, "createdAt", "emailVerified" FROM "user" ORDER BY "createdAt", id');
  return json({ users });
};

export const POST: RequestHandler = async (event) => {
  const admin = await requireAdmin(event);
  const body = await readJsonObject(event.request);
  const id = (event.params as Record<string, string>).id ?? body.id;
  if (typeof id !== 'string' || !id || id.length > 200 || (body.enabled !== undefined && typeof body.enabled !== 'boolean') || (body.approved !== undefined && typeof body.approved !== 'boolean') || (body.role !== undefined && body.role !== 'member' && body.role !== 'admin')) error(400, 'Invalid user update');
  if (body.enabled === undefined && body.approved === undefined && body.role === undefined) error(400, 'No update supplied');
  if (id === admin.id && (body.enabled === false || body.approved === false || body.role === 'member')) error(400, 'You cannot disable, unapprove or demote your own account');
  const user = await transaction(async (client) => {
    // Lock admin updates together so two concurrent changes cannot remove every administrator.
    await client.query('SELECT pg_advisory_xact_lock(782411)');
    const { rows: [current] } = await client.query('SELECT id,role,enabled,approved FROM "user" WHERE id=$1 FOR UPDATE', [id]);
    if (!current) error(404, 'Unknown user');
    if (current.enabled && current.approved && current.role === 'admin' && (body.enabled === false || body.approved === false || body.role === 'member')) {
      const { rows: [{ count }] } = await client.query("SELECT count(*)::int AS count FROM \"user\" WHERE role='admin' AND enabled=true AND approved=true");
      if (count <= 1) error(400, 'Keep at least one enabled administrator');
    }
    const { rows: [updated] } = await client.query('UPDATE "user" SET enabled=COALESCE($2,enabled),role=COALESCE($3,role),approved=COALESCE($4,approved),"updatedAt"=now() WHERE id=$1 RETURNING id,username,email,role,enabled,approved,"createdAt"', [id, body.enabled ?? null, body.role ?? null, body.approved ?? null]);
    if (body.enabled === false || body.approved === false) {
      await client.query('DELETE FROM session WHERE "userId"=$1', [id]);
      await client.query('UPDATE playback_tokens SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [id]);
    }
    await client.query('INSERT INTO audit_log(user_id,action,target,details) VALUES ($1,\'user.update\',$2,$3)', [admin.id, id, JSON.stringify({ enabled: updated.enabled, approved: updated.approved, role: updated.role })]);
    return updated;
  });
  return json({ user });
};
