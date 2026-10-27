import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { error, json, redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireMember } from '#lib/server/permissions.js';
import { listTorrents, torrentAction } from '#lib/server/qbittorrent.js';
import { resolveFile } from '#lib/server/files.js';
import { invalidateSnapshot } from '#lib/server/torrent-stream.js';
import { rateLimit } from '#lib/server/rate-limit.js';
import { audit } from '#lib/server/audit.js';
import { readJson } from '#lib/server/network.js';

export const GET: RequestHandler = async (event) => {
	await requireMember(event);
	if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(event.params.hash)) error(400, 'Hash invalide.');
	const torrent = (await listTorrents()).find((torrent) => torrent.hash === event.params.hash);
	if (!torrent) error(404, 'Torrent introuvable.');
	const content = torrent.content_path || torrent.save_path;
	if (!content || !path.posix.isAbsolute(content)) error(404, 'Dossier du torrent indisponible.');
	const relative = path.posix.relative(process.env.QBT_DOWNLOAD_PATH ?? '/data/downloads', content);
	const file = await resolveFile('downloads', relative, true);
	const stat = await lstat(file.absolute).catch((cause: NodeJS.ErrnoException) => {
		if (cause.code !== 'ENOENT') throw cause;
		return null;
	});
	const directory = stat?.isDirectory() ? file.relative : path.posix.dirname(file.relative);
	redirect(303, `/files?${new URLSearchParams({ space: 'downloads', path: directory === '.' ? '' : directory })}`);
};

export const POST: RequestHandler = async (event) => {
	const user = await requireMember(event);
	rateLimit(`torrent-action:${user.id}`, 60);
	const input = await readJson(event.request);
	await audit(user.id, `torrent.${input.action}.requested`, {}, event.params.hash);
	const result = await torrentAction(event.params.hash, String(input.action), input.confirm === true);
	invalidateSnapshot();
	return json(result);
};
