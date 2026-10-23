import { json } from '@sveltejs/kit';
import { requireAdmin } from '#lib/server/permissions.js';
import { query } from '#lib/server/db.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async (event) => {
  await requireAdmin(event);
  const [backup] = await query('SELECT completed_at AS "completedAt",details FROM backup_runs WHERE status=\'completed\' ORDER BY completed_at DESC LIMIT 1');
  return json({ backup: backup ?? null });
};
