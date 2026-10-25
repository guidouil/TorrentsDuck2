import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readJsonObject, requireMember } from '#lib/server/permissions.js';
import { rateLimit } from '#lib/server/rate-limit.js';
import { startSearch, searchResults, deleteSearch } from '#lib/server/torrent-search.js';

export const POST: RequestHandler = async (event) => {
	const user = await requireMember(event);
	rateLimit('search-start:' + user.id, 10);
	const body = await readJsonObject(event.request);
	return json(await startSearch(user.id, body.query, body.source), { status: 201 });
};

export const GET: RequestHandler = async (event) => {
	const user = await requireMember(event);
	rateLimit('search-results:' + user.id, 120);
	const params = event.url.searchParams;
	return json(await searchResults(params.get('id'), user.id, Number(params.get('offset') ?? 0), {
		sort: params.get('sort') ?? 'seeders',
		minSeeders: Number(params.get('minSeeders') ?? 0),
		minSize: Number(params.get('minSize') ?? 0),
		...(params.has('maxSize') ? { maxSize: Number(params.get('maxSize')) } : {})
	}), { headers: { 'Cache-Control': 'no-store' } });
};

export const DELETE: RequestHandler = async (event) => {
	const user = await requireMember(event);
	rateLimit('search-delete:' + user.id, 20);
	const body = await readJsonObject(event.request);
	await deleteSearch(body.id, user.id);
	return json({ ok: true });
};
