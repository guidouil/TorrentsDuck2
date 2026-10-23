import { error, json } from '@sveltejs/kit';
import { readJsonObject, requireInternal } from '#lib/server/permissions.js';
import { query } from '#lib/server/db.js';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
  requireInternal(request);
  const body = await readJsonObject(request);
  if (typeof body.completedAt !== 'string') error(400, 'Invalid backup date');
  const completedAt = new Date(body.completedAt);
  if (!Number.isFinite(completedAt.getTime()) || completedAt.getTime() > Date.now() + 60_000 || typeof body.archive !== 'string' || body.archive.length > 500 || typeof body.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(body.sha256)) error(400, 'Invalid backup metadata');
  await query('INSERT INTO backup_runs(status,completed_at,details) VALUES (\'completed\',$1,$2)', [completedAt, JSON.stringify({ archive: body.archive, sha256: body.sha256 })]);
  return json({ recorded: true });
};
