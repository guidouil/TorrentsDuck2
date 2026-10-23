import type { RequestHandler } from './$types';
import { requireMember } from '#lib/server/permissions.js';
import { subscribeTorrents } from '#lib/server/torrent-stream.js';

export const GET: RequestHandler = async (event) => {
	const user = await requireMember(event);
	return subscribeTorrents(event, user.id);
};
