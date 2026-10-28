import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readJsonObject, requireMember } from '#lib/server/permissions.js';
import { rateLimit } from '#lib/server/rate-limit.js';
import { createStudioProject, studioProjects } from '#lib/server/studio.js';

export const GET: RequestHandler = async (event) => {
	const user = await requireMember(event);
	return json({ projects: await studioProjects(user.id) });
};

export const POST: RequestHandler = async (event) => {
	const user = await requireMember(event);
	rateLimit(`studio:projects:${user.id}`, 20);
	const input = await readJsonObject(event.request);
	return json({ project: await createStudioProject(user.id, input.name) }, { status: 201 });
};
