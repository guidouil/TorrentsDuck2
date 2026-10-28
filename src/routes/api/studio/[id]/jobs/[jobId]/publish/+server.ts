import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readJsonObject, requireMember } from '#lib/server/permissions.js';
import { rateLimit } from '#lib/server/rate-limit.js';
import { publishStudioJob } from '#lib/server/studio.js';

export const POST: RequestHandler = async (event) => {
	const user = await requireMember(event);
	rateLimit(`studio:publish:${user.id}`, 10);
	return json(await publishStudioJob(user.id, event.params.id, event.params.jobId, await readJsonObject(event.request)));
};
