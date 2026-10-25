import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { error } from '@sveltejs/kit';
import { qbt } from './qbittorrent';
import catalog from '../../../deploy/qbittorrent/search/catalog.json';
import { urlSources, searchUrlSource, downloadUrlResult, SourceError, type UrlResult } from './url-sources';
import type { SourceResult } from './source-detection';

export async function searchSources() {
	const custom = await urlSources();
	let engineAvailable = true;
	const plugins: { name: string; enabled: boolean }[] = await qbt('search/plugins').then((response) => response.json()).catch(() => { engineAvailable = false; return []; });
	if (!Array.isArray(plugins)) error(503, 'Réponse des sources invalide.');
	const builtin = catalog.map(({ id, name, url, description }) => {
		const plugin = plugins.find((plugin) => plugin?.name === id);
		return { id, name, url, description, kind: 'plugin' as const, available: engineAvailable, installed: !!plugin, enabled: plugin?.enabled === true };
	});
	return [...builtin, ...custom];
}

export async function changeSearchSource(id: unknown, action: unknown) {
	if (typeof id !== 'string' || !catalog.some((source) => source.id === id) || typeof action !== 'string' ||
		!['install', 'uninstall', 'enable', 'disable'].includes(action)) error(400, 'Source ou action invalide.');
	if (action === 'install') {
		await qbt('search/installPlugin', new URLSearchParams({ sources: '/usr/local/share/torrentduck/search/' + id + '.py' }));
	} else if (action === 'uninstall') {
		await qbt('search/uninstallPlugin', new URLSearchParams({ names: id }));
	} else {
		await qbt('search/enablePlugin', new URLSearchParams({ names: id, enable: String(action === 'enable') }));
	}
	// qBittorrent may finish installing a plugin after its HTTP response.
	for (let attempt = 0; attempt < 20; attempt++) {
		const source = (await searchSources()).find((source) => source.id === id)!;
		if (action === 'uninstall' ? !source.installed : action === 'install' ? source.installed : source.installed && source.enabled === (action === 'enable')) return;
		await delay(100);
	}
	error(503, 'La modification de la source n’a pas été confirmée.');
}

type Job = { userId: string; engineId?: number; engineRunning: boolean; running: boolean; customPending: boolean; custom: UrlResult[]; diagnostics: { source: string; message: string; diagnostic: string }[]; expired?: boolean; stop?: ReturnType<typeof setTimeout>; expiry?: ReturnType<typeof setTimeout> };
// shortcut: job ownership lives in one app process; persist it before running replicas.
const jobs = new Map<string, Job>();

async function discard(id: string, job: Job) {
	job.expired = true;
	if (job.engineId !== undefined) {
		if (job.engineRunning) {
			await qbt('search/stop', new URLSearchParams({ id: String(job.engineId) }));
			job.engineRunning = false;
		}
		await qbt('search/delete', new URLSearchParams({ id: String(job.engineId) }));
	}
	clearTimeout(job.stop); clearTimeout(job.expiry);
	jobs.delete(id);
}

async function expire(id: string, job: Job) {
	job.expired = true;
	try { await discard(id, job); }
	catch {
		const status = await qbt('search/status').then((response) => response.json()).catch(() => null);
		if (Array.isArray(status) && !status.some((entry) => entry?.id === job.engineId)) {
			clearTimeout(job.stop); jobs.delete(id);
			return;
		}
		job.expiry = setTimeout(() => { void expire(id, job); }, 30_000);
		job.expiry.unref();
	}
}

function ownedJob(id: unknown, userId: string) {
	if (typeof id !== 'string' || !id || id.length > 100) error(400, 'Recherche invalide.');
	const job = jobs.get(id);
	if (!job || job.expired || job.userId !== userId) error(404, 'Recherche introuvable ou expirée.');
	return job;
}

export async function startSearch(userId: string, query: unknown, source: unknown) {
	if (typeof query !== 'string' || query.trim().length < 2 || query.length > 200 || /[\u0000-\u001f]/.test(query)) error(400, 'La recherche doit contenir entre 2 et 200 caractères.');
	const available = await searchSources();
	if (source !== undefined && (typeof source !== 'string' || !available.some((entry) => entry.id === source))) error(400, 'Source invalide.');
	if (!available.some((entry) => entry.enabled && (source === undefined || entry.id === source)) && available.some((entry) => entry.kind === 'plugin' && !entry.available && (source === undefined || entry.id === source))) error(503, 'Le moteur qBittorrent est indisponible.');
	const selected = available.filter((entry) => entry.enabled && (source === undefined || entry.id === source));
	if (!selected.length) error(400, 'Aucune source active pour cette recherche.');
	const active = [...jobs.values()].filter((job) => job.running);
	if (active.some((job) => job.userId === userId) || active.length >= 4 || jobs.size >= 30) error(429, 'Trop de recherches. Attendez la fin de la recherche en cours.');
	const id = randomUUID();
	const custom = selected.filter((entry) => entry.kind === 'url');
	const plugins = selected.filter((entry) => entry.kind === 'plugin');
	const job: Job = { userId, running: true, engineRunning: false, customPending: custom.length > 0, custom: [], diagnostics: [] };
	jobs.set(id, job);
	try {
		if (plugins.length) {
			try {
				const started = await (await qbt('search/start', new URLSearchParams({ pattern: query.trim(), plugins: plugins.map((entry) => entry.id).join('|'), category: 'all' }))).json();
				if (!started || !Number.isSafeInteger(started.id) || started.id < 0) error(503, 'Réponse de recherche invalide.');
				job.engineId = started.id;
				job.engineRunning = true;
			} catch (cause) {
				if (!custom.length) throw cause;
				job.diagnostics.push({ source: 'qBittorrent', message: 'Le moteur qBittorrent est indisponible ; les sources URL restent interrogées.', diagnostic: JSON.stringify({ diagnosticVersion: 1, reason: 'engine-unavailable' }) });
			}
		}
		if (custom.length) void Promise.all(custom.map(async (source) => {
			try {
				const results = await searchUrlSource(source.id, query.trim());
				if (!job.expired) job.custom.push(...results.slice(0, Math.max(0, 2000 - job.custom.length)));
			} catch (cause) {
				if (!job.expired) job.diagnostics.push({ source: source.name, message: cause instanceof SourceError ? cause.message : 'La source ne répond pas.', diagnostic: cause instanceof SourceError ? cause.diagnostic : JSON.stringify({ diagnosticVersion: 1, reason: 'source-request-failed' }) });
			}
		})).finally(() => { job.customPending = false; job.running = job.engineRunning; });
		job.stop = setTimeout(() => {
			if (job.engineId !== undefined) void qbt('search/stop', new URLSearchParams({ id: String(job.engineId) })).then(() => { job.engineRunning = false; job.running = job.customPending; }).catch(() => { /* Expiry will retry cleanup. */ });
		}, 90_000);
		job.expiry = setTimeout(() => { void expire(id, job); }, 300_000);
		job.stop.unref(); job.expiry.unref();
		return { id };
	} catch (cause) { jobs.delete(id); throw cause; }
}

function safeUrl(value: unknown, magnet = false) {
	if (typeof value !== 'string' || value.length > 16_384) return '';
	try {
		const url = new URL(value);
		return !url.username && !url.password && (['http:', 'https:'].includes(url.protocol) || (magnet && url.protocol === 'magnet:')) ? url.href : '';
	} catch { return ''; }
}

function count(value: unknown) { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : -1; }

type SearchFilters = { sort?: string; minSeeders?: number; minSize?: number; maxSize?: number };

export async function searchResults(id: string | null, userId: string, offset: number, filters: SearchFilters = {}) {
	const job = ownedJob(id, userId);
	if (!Number.isSafeInteger(offset) || offset < 0) error(400, 'Pagination invalide.');
	const { sort = 'seeders', minSeeders = 0, minSize = 0, maxSize } = filters;
	if (!['seeders', 'leechers', 'date', 'size', 'name'].includes(sort) ||
		![minSeeders, minSize, ...(maxSize === undefined ? [] : [maxSize])].every((value) => Number.isSafeInteger(value) && value >= 0) ||
		(maxSize !== undefined && maxSize < minSize)) error(400, 'Filtres invalides.');
	const result = job.engineId === undefined ? { results: [], total: 0, status: 'Stopped' } : await qbt('search/results?' + new URLSearchParams({ id: String(job.engineId), limit: '2000', offset: '0' })).then((response) => response.json()).catch((cause) => {
		if (!job.custom.length && !job.customPending) throw cause;
		if (!job.diagnostics.some((entry) => entry.source === 'qBittorrent')) job.diagnostics.push({ source: 'qBittorrent', message: 'Résultats qBittorrent temporairement indisponibles.', diagnostic: JSON.stringify({ diagnosticVersion: 1, reason: 'engine-unavailable' }) });
		return { results: [], total: 0, status: job.engineRunning ? 'Running' : 'Stopped' };
	});
	if (!result || !Array.isArray(result.results) || !Number.isSafeInteger(result.total) || result.total < 0 || !['Running', 'Stopped'].includes(result.status)) error(503, 'Réponse de recherche invalide.');
	job.engineRunning = result.status === 'Running';
	job.running = job.engineRunning || job.customPending;
	if (!job.running) clearTimeout(job.stop);
	const entries: unknown[] = result.results.slice(0, 2000);
	const engineResults = entries.flatMap((input) => {
		if (!input || typeof input !== 'object') return [];
		const entry = input as Record<string, unknown>;
		if (typeof entry.fileName !== 'string' || !entry.fileName.trim()) return [];
		const url = safeUrl(entry.fileUrl, true);
		if (!url) return [];
		const site = safeUrl(entry.siteUrl);
		const source = site ? catalog.find((source) => new URL(source.url).hostname === new URL(site).hostname)?.name ?? new URL(site).hostname : '';
		const timestamp = count(entry.pubDate);
		return [{ name: entry.fileName.slice(0, 1000), size: count(entry.fileSize), seeders: count(entry.nbSeeders), leechers: count(entry.nbLeechers), publishedAt: timestamp > 0 && timestamp <= 8_640_000_000_000 ? timestamp * 1000 : null, url, descriptionUrl: safeUrl(entry.descrLink), source }];
	});
	const results: SourceResult[] = [...engineResults, ...job.custom.map(({ result }, index) => ({ ...result, url: 'search:' + id + ':' + index, descriptionUrl: '' }))].slice(0, 2000);
	const filtered = results.filter((entry) =>
		(!minSeeders || entry.seeders >= minSeeders) && (!minSize || entry.size >= minSize) && (maxSize === undefined || (entry.size >= 0 && entry.size <= maxSize))
	).sort((a, b) => {
		const order = sort === 'name' ? a.name.localeCompare(b.name) : sort === 'date' ? (b.publishedAt ?? -1) - (a.publishedAt ?? -1) : b[sort as 'seeders' | 'leechers' | 'size'] - a[sort as 'seeders' | 'leechers' | 'size'];
		return order || a.name.localeCompare(b.name);
	});
	return { results: filtered.slice(offset, offset + 100), total: filtered.length, running: job.running, available: result.total + job.custom.length, fetched: results.length, truncated: result.total + job.custom.length > 2000, diagnostics: job.diagnostics };
}

export async function resolveSearchResult(reference: string, userId: string) {
	const match = /^search:([a-f0-9-]{36}):(\d{1,4})$/.exec(reference);
	if (!match) error(400, 'Résultat de recherche invalide.');
	const job = ownedJob(match[1], userId);
	const value = job.custom[Number(match[2])];
	if (!value) error(404, 'Résultat introuvable.');
	return downloadUrlResult(value);
}

export async function deleteSearch(id: unknown, userId: string) {
	const job = ownedJob(id, userId);
	await discard(id as string, job);
}
