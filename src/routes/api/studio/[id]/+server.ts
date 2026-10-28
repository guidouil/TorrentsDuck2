import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readJsonObject, requireMember } from '#lib/server/permissions.js';
import { deleteStudioProject, ownedStudioProject, studioJobs, updateStudioProject } from '#lib/server/studio.js';

export const GET: RequestHandler = async (event) => {
	const user = await requireMember(event);
	const project = await ownedStudioProject(user.id, event.params.id);
	return json({ project, jobs: await studioJobs(user.id, project.id) });
};

export const PATCH: RequestHandler = async (event) => {
	const user = await requireMember(event);
	return json({ project: await updateStudioProject(user.id, event.params.id, await readJsonObject(event.request)) });
};

export const DELETE: RequestHandler = async (event) => {
	const user = await requireMember(event);
	const input = await readJsonObject(event.request);
	return json(await deleteStudioProject(user.id, event.params.id, input.confirm));
};
