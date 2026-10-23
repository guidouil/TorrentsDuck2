import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireMember } from '#lib/server/permissions.js';
import { query } from '#lib/server/db.js';
import { rateLimit } from '#lib/server/rate-limit.js';
import { readJson } from '#lib/server/network.js';

export const GET: RequestHandler = async (event) => {
	await requireMember(event);
	const cursor = event.url.searchParams.get('before');
	if (cursor && (!/^\d{1,19}$/.test(cursor) || BigInt(cursor) > 9223372036854775807n)) error(400, 'Curseur invalide.');
	const messages = await query('SELECT m.id::text,m.body,m.created_at AS "createdAt",m.user_id AS "userId",COALESCE(u.name,\'Ancien membre\') AS name FROM messages m LEFT JOIN "user" u ON u.id=m.user_id WHERE ($1::bigint IS NULL OR m.id<$1) ORDER BY m.id DESC LIMIT 50', [cursor]);
	return json({ messages: messages.reverse(), nextCursor: messages.length === 50 ? messages[0].id : null });
};

export const POST: RequestHandler = async (event) => {
	const user = await requireMember(event);
	rateLimit(`chat:${user.id}`, 20);
	const input = await readJson(event.request);
	if (typeof input.body !== 'string' || !input.body.trim() || input.body.length > 2000) error(400, 'Message requis, 2000 caractères maximum.');
	const [message] = await query('INSERT INTO messages(user_id,body) VALUES($1,$2) RETURNING id::text,body,created_at AS "createdAt",user_id AS "userId"', [user.id, input.body.trim()]);
	return json({ message: { ...message, name: user.name } }, { status: 201 });
};
