import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireMember } from '#lib/server/permissions.js';
import { fileSpace, listStreamingFiles } from '#lib/server/files.js';
import { rateLimit } from '#lib/server/rate-limit.js';

export const GET: RequestHandler = async (event) => {
	const user = await requireMember(event);
	rateLimit(`streaming:${user.id}`, 30);
	return json(await listStreamingFiles(fileSpace(event.url.searchParams.get('space') ?? 'downloads'), event.url.searchParams.get('search') ?? ''), { headers: { 'cache-control': 'private, no-store' } });
};
