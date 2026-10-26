import { error, isHttpError, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireMember } from '#lib/server/permissions.js';
import { fileSpace, listFiles, changeFiles, uploadFile } from '#lib/server/files.js';
import { rateLimit } from '#lib/server/rate-limit.js';
import { audit } from '#lib/server/audit.js';
import { readJson } from '#lib/server/network.js';

export const GET: RequestHandler = async (event) => {
	await requireMember(event);
	return json(await listFiles(fileSpace(event.url.searchParams.get('space') ?? 'downloads'), event.url.searchParams.get('path') ?? '', event.url.searchParams));
};

export const POST: RequestHandler = async (event) => {
	const user = await requireMember(event);
	rateLimit(`files:${user.id}`, 30);
	if (event.request.headers.get('content-type')?.startsWith('multipart/form-data')) {
		try {
			const result = await uploadFile(event);
			await audit(user.id, 'file.upload', { path: result.path });
			return json(result, { status: 201 });
		} catch (cause) { if (isHttpError(cause)) throw cause; error(400, 'Upload interrompu ou fichier invalide.'); }
	}
	const input = await readJson(event.request);
	await audit(user.id, `file.${input.action}.requested`, { space: input.space, path: input.path });
	return json(await changeFiles(input, user.role));
};
