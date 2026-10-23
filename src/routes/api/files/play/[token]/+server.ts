import type { RequestHandler } from './$types';
import { playbackFile } from '#lib/server/playback.js';
import { downloadFile } from '#lib/server/files.js';

export const GET: RequestHandler = async (event) => {
	const file = await playbackFile(event.params.token);
	return downloadFile(event, file.space, file.path, true);
};
export const HEAD = GET;
