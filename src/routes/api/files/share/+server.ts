import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireMember } from '#lib/server/permissions.js';
import { createPlayback, revokePlayback } from '#lib/server/playback.js';
import { rateLimit } from '#lib/server/rate-limit.js';
import { query } from '#lib/server/db.js';
import { audit } from '#lib/server/audit.js';
import { readJson } from '#lib/server/network.js';

export const GET: RequestHandler = async (event) => {
	const user = await requireMember(event);
	return json({ links: await query('SELECT id,space,path,expires_at AS "expiresAt" FROM playback_tokens WHERE user_id=$1 AND revoked_at IS NULL AND expires_at>now() ORDER BY created_at DESC', [user.id]) });
};
export const POST: RequestHandler = async (event) => {
	const user = await requireMember(event);
	rateLimit(`playback:${user.id}`, 20);
	const link = await createPlayback(user.id, await readJson(event.request), event.url.origin);
	await audit(user.id, 'playback.create', {}, link.id);
	return json(link, { status: 201 });
};
export const DELETE: RequestHandler = async (event) => {
	const user = await requireMember(event);
	const input = await readJson(event.request);
	const result = await revokePlayback(user.id, input);
	await audit(user.id, 'playback.revoke', {}, typeof input.id === 'string' ? input.id : undefined);
	return json(result);
};
