import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireMember } from '#lib/server/permissions.js';
import { fileAudioTracks, fileSpace } from '#lib/server/files.js';

export const GET: RequestHandler = async (event) => {
	await requireMember(event);
	return json({ audioTracks: await fileAudioTracks(fileSpace(event.url.searchParams.get('space') ?? 'downloads'), event.url.searchParams.get('path') ?? '') }, { headers: { 'cache-control': 'private, no-store' } });
};
