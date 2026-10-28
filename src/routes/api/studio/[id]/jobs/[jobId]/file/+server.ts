import type { RequestHandler } from './$types';
import { requireMember } from '#lib/server/permissions.js';
import { studioFile } from '#lib/server/studio.js';

export const GET: RequestHandler = async (event) => {
	const user = await requireMember(event);
	return studioFile(event, user.id, event.params.id, event.params.jobId);
};
export const HEAD = GET;
