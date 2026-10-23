import { error } from '@sveltejs/kit';
import { auth, findByIdentifier } from '#lib/server/auth.js';
import { rateLimit } from '#lib/server/rate-limit.js';
import { readJsonObject } from '#lib/server/permissions.js';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async (event) => {
  rateLimit(`login:${event.getClientAddress()}`, 10, 60_000);
  const body = await readJsonObject(event.request);
  if (typeof body.identifier !== 'string' || typeof body.password !== 'string' || body.password.length > 1024) error(400, 'Invalid credentials');
  const user = await findByIdentifier(body.identifier);
  if (!user?.enabled) error(401, 'Invalid credentials');
  return auth.api.signInEmail({
    body: { email: user.email, password: body.password, rememberMe: body.rememberMe !== false },
    headers: event.request.headers,
    asResponse: true
  });
};
