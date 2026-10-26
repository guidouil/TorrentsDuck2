import { error, json } from '@sveltejs/kit';
import { verifyCredentials } from '#lib/server/auth.js';
import { readJsonObject, requireInternal } from '#lib/server/permissions.js';
import { rateLimit } from '#lib/server/rate-limit.js';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
  requireInternal(request);
  const body = await readJsonObject(request);
  const identifier = body.username ?? body.identifier;
  if (typeof identifier !== 'string' || typeof body.password !== 'string' || identifier.length > 320) error(401, 'Unauthorized');
  rateLimit(`ftp:${identifier}`, 10);
  const user = await verifyCredentials(identifier, body.password);
  if (!user) error(401, 'Unauthorized');
  return json({ authorized: true, role: user.role });
};
