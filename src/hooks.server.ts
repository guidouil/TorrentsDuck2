import { error } from '@sveltejs/kit';
import type { Handle } from '@sveltejs/kit/hooks';
import { building } from '$app/env';
import { validateAuthEnvironment } from '#lib/server/auth.js';
import { startTorrentMonitor } from '#lib/server/torrent-stream.js';

export function init() {
  if (!building) { validateAuthEnvironment(); startTorrentMonitor(); }
}

export const handle: Handle = async ({ event, resolve }) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(event.request.method) && !event.url.pathname.startsWith('/api/internal/')) {
    const origin = event.request.headers.get('origin');
    const expected = process.env.ORIGIN || event.url.origin;
    if (origin !== expected || event.request.headers.get('sec-fetch-site') === 'cross-site') error(403, 'Origine de la requête refusée.');
  }
  const response = await resolve(event);
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('Referrer-Policy', 'no-referrer');
  response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (!event.url.pathname.startsWith('/_app/') && !event.url.pathname.startsWith('/favicon')) response.headers.set('Cache-Control', 'no-store');
  return response;
};
