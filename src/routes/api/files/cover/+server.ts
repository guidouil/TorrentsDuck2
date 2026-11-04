import type { RequestHandler } from './$types';
import { requireMember } from '#lib/server/permissions.js';
import { fileSpace } from '#lib/server/files.js';
import { fileCover } from '#lib/server/covers.js';

export const GET: RequestHandler = async (event) => {
	await requireMember(event);
	const cover = await fileCover(fileSpace(event.url.searchParams.get('space') ?? 'downloads'), event.url.searchParams.get('path') ?? '');
	const headers = { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' };
	return cover ? new Response(new Uint8Array(cover.body), { headers: { ...headers, 'content-type': cover.contentType } }) :
		new Response(null, { status: 307, headers: { ...headers, location: '/cover-placeholder.svg' } });
};
