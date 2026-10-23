import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireMember } from '#lib/server/permissions.js';
import { torrentAction } from '#lib/server/qbittorrent.js';
import { invalidateSnapshot } from '#lib/server/torrent-stream.js';
import { rateLimit } from '#lib/server/rate-limit.js';
import { audit } from '#lib/server/audit.js';
import { readJson } from '#lib/server/network.js';

export const POST: RequestHandler = async (event) => {
	const user = await requireMember(event);
	rateLimit(`torrent-action:${user.id}`, 60);
	const input = await readJson(event.request);
	await audit(user.id, `torrent.${input.action}.requested`, {}, event.params.hash);
	const result = await torrentAction(event.params.hash, String(input.action), input.confirm === true);
	invalidateSnapshot();
	return json(result);
};
