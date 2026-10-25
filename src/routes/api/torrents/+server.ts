import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireMember } from '#lib/server/permissions.js';
import { addTorrent } from '#lib/server/qbittorrent.js';
import { torrentSnapshot, invalidateSnapshot } from '#lib/server/torrent-stream.js';
import { rateLimit } from '#lib/server/rate-limit.js';
import { audit } from '#lib/server/audit.js';
import { resolveSearchResult } from '#lib/server/torrent-search.js';
import { SourceError } from '#lib/server/url-sources.js';
import { requireStorage } from '#lib/server/storage.js';

export const GET: RequestHandler = async (event) => {
	await requireMember(event);
	return json(await torrentSnapshot());
};

export const POST: RequestHandler = async (event) => {
	const user = await requireMember(event);
	rateLimit(`torrent-add:${user.id}`, 20);
	if (Number(event.request.headers.get('content-length') ?? 0) > 9 * 1024 * 1024) error(413, 'Requête trop volumineuse.');
	let bytes = 0;
	const limited = event.request.body?.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk, controller) {
			bytes += chunk.byteLength;
			if (bytes > 9 * 1024 * 1024) error(413, 'Requête trop volumineuse.');
			controller.enqueue(chunk);
		}
	}));
	const request = new Request(event.request.url, { method: 'POST', headers: event.request.headers, body: limited, duplex: 'half' } as RequestInit);
	let source: string | File;
	if (event.request.headers.get('content-type')?.includes('application/json')) {
		const body = await request.json();
		if (typeof body.source !== 'string') error(400, 'Source requise.');
		source = body.source.trim();
	} else {
		const form = await request.formData();
		const value = form.get('torrent') ?? form.get('source');
		if (typeof value !== 'string' && !(value instanceof File)) error(400, 'Source requise.');
		source = typeof value === 'string' ? value.trim() : value;
	}
	let result;
	try {
		if (typeof source === 'string' && source.startsWith('search:')) {
			await requireStorage();
			source = await resolveSearchResult(source, user.id);
		}
		result = await addTorrent(source, user.id);
	} catch (cause) {
		if (cause instanceof SourceError) return json({ message: cause.message, diagnostic: cause.diagnostic }, { status: cause.status, headers: { 'Cache-Control': 'no-store' } });
		throw cause;
	}
	invalidateSnapshot();
	await audit(user.id, 'torrent.add');
	return json(result, { status: 201 });
};
