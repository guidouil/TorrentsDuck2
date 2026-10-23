import { auth } from '#lib/server/auth.js';
import { rateLimit } from '#lib/server/rate-limit.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ request }) => auth.handler(request);
export const POST: RequestHandler = (event) => {
  rateLimit(`auth:${event.getClientAddress()}`, 20, 60_000);
  return auth.handler(event.request);
};
