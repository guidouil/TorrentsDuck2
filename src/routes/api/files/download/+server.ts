import type { RequestHandler } from './$types';
import { error } from '@sveltejs/kit';
import { requireMember } from '#lib/server/permissions.js';
import { downloadFile, fileSpace } from '#lib/server/files.js';

export const GET: RequestHandler = async (event) => {
	await requireMember(event);
	const audio = event.url.searchParams.get('audio');
	if (audio !== null && (!/^[1-9]\d*$/.test(audio) || !Number.isSafeInteger(Number(audio)))) error(400, 'Piste audio invalide.');
	return downloadFile(event, fileSpace(event.url.searchParams.get('space') ?? 'downloads'), event.url.searchParams.get('path') ?? '', event.url.searchParams.get('inline') === '1', audio === null ? undefined : Number(audio));
};
export const HEAD = GET;
