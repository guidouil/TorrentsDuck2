import { json } from '@sveltejs/kit';
import { query } from '#lib/server/db.js';
import { requireInternal } from '#lib/server/permissions.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ request }) => {
  requireInternal(request);
  const [policy] = await query<{ revision: string }>("SELECT COALESCE(max(id),0)::text AS revision FROM audit_log WHERE action IN ('user.delete','user.password-reset','user.password-change') OR (action='user.update' AND (details->>'enabled'='false' OR details->>'approved'='false'))");
  return json(policy);
};
