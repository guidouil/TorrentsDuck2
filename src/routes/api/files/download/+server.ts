import type { RequestHandler } from './$types';
import { requireMember } from '#lib/server/permissions.js';
import { downloadFile, fileSpace } from '#lib/server/files.js';

export const GET: RequestHandler = async (event) => {
	await requireMember(event);
	return downloadFile(event, fileSpace(event.url.searchParams.get('space') ?? 'downloads'), event.url.searchParams.get('path') ?? '', event.url.searchParams.get('inline') === '1');
};
export const HEAD = GET;
