import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readJsonObject, requireMember } from '#lib/server/permissions.js';
import { deleteStudioJob } from '#lib/server/studio.js';

export const DELETE: RequestHandler = async (event) => {
	const user = await requireMember(event);
	const input = await readJsonObject(event.request);
	return json(await deleteStudioJob(user.id, event.params.id, event.params.jobId, input.confirm));
};
