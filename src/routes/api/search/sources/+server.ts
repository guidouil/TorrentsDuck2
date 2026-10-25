import { isHttpError, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readJsonObject, requireMember, requireSourceManager } from '#lib/server/permissions.js';
import { audit } from '#lib/server/audit.js';
import { rateLimit } from '#lib/server/rate-limit.js';
import { searchSources, changeSearchSource } from '#lib/server/torrent-search.js';
import { addUrlSource, changeUrlSource, testUrlSource, SourceError } from '#lib/server/url-sources.js';

export const GET: RequestHandler = async (event) => {
	const user = await requireMember(event);
	return json({ sources: await searchSources(), canManage: user.role === 'admin' || user.canManageSources === true }, { headers: { 'Cache-Control': 'no-store' } });
};

export const POST: RequestHandler = async (event) => {
	const user = await requireSourceManager(event);
	rateLimit('search-sources:' + user.id, 20);
	const body = await readJsonObject(event.request);
	try {
		if (body.action === 'add') {
			const result = await addUrlSource(body, user.id);
			await audit(user.id, 'search.source.add', { source: result.source.id });
			return json(result, { status: 201, headers: { 'Cache-Control': 'no-store' } });
		}
		if (typeof body.id === 'string' && body.id.startsWith('url:')) {
			if (body.action === 'test') return json(await testUrlSource(body.id), { headers: { 'Cache-Control': 'no-store' } });
			await changeUrlSource(body.id, body.action);
		} else await changeSearchSource(body.id, body.action);
		await audit(user.id, 'search.source.' + body.action, { source: body.id });
		return json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
	} catch (cause) {
		if (cause instanceof SourceError) return json({ message: cause.message, diagnostic: cause.diagnostic }, { status: cause.status, headers: { 'Cache-Control': 'no-store' } });
		const status = isHttpError(cause) ? cause.status : 503;
		return json({ message: isHttpError(cause) ? cause.body.message : 'Impossible de modifier la source.', diagnostic: JSON.stringify({ diagnosticVersion: 1, stage: 'source-operation', reason: status === 400 ? 'invalid-source-action' : 'service-unavailable', status }, null, 2) }, { status, headers: { 'Cache-Control': 'no-store' } });
	}
};
