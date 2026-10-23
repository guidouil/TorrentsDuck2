export { POST as PATCH } from '../+server';

import { error, json } from '@sveltejs/kit';
import { readJsonObject, requireAdmin } from '#lib/server/permissions.js';
import { transaction } from '#lib/server/db.js';
import type { RequestHandler } from './$types';

export const DELETE: RequestHandler = async (event) => {
  const admin = await requireAdmin(event);
  const body = await readJsonObject(event.request);
  if (body.confirm !== true) error(400, 'Explicit account deletion confirmation required');
  const id = event.params.id;
  if (id === admin.id) error(400, 'You cannot delete your own account');
  await transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(782411)');
    const { rows: [user] } = await client.query('SELECT id,username,role,enabled,approved FROM "user" WHERE id=$1 FOR UPDATE', [id]);
    if (!user) error(404, 'Unknown user');
    if (user.enabled && user.approved && user.role === 'admin') {
      const { rows: [{ count }] } = await client.query("SELECT count(*)::int AS count FROM \"user\" WHERE enabled=true AND approved=true AND role='admin'");
      if (count <= 1) error(400, 'Keep at least one enabled administrator');
    }
    await client.query('INSERT INTO audit_log(user_id,action,target,details) VALUES ($1,\'user.delete\',$2,$3)', [admin.id, id, JSON.stringify({ username: user.username })]);
    await client.query('DELETE FROM "user" WHERE id=$1', [id]);
  });
  return json({ deleted: true });
};
