import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readJsonObject, requireMember } from '#lib/server/permissions.js';
import { rateLimit } from '#lib/server/rate-limit.js';
import { createStudioJob } from '#lib/server/studio.js';

export const POST: RequestHandler = async (event) => {
	const user = await requireMember(event);
	rateLimit(`studio:jobs:${user.id}`, 30);
	return json({ job: await createStudioJob(user.id, event.params.id, await readJsonObject(event.request)) }, { status: 202 });
};
