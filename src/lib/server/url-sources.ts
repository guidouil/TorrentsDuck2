import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, randomUUID } from 'node:crypto';
import { isHttpError } from '@sveltejs/kit';
import { query, transaction } from './db';
import { fetchSource, MAX_TORRENT_BYTES } from './network';
import { detectSourceResponse, type SourceResult } from './source-detection';

type Auth = { type: 'none' | 'basic' | 'bearer' | 'apiKey'; username?: string; password?: string; token?: string };
type Config = { url: string; auth: Auth };
type Source = { id: string; name: string; origin: string; config: string; format: 'json' | 'rss' | 'html'; authenticated: boolean; enabled: boolean };

export class SourceError extends Error {
	constructor(message: string, public diagnostic: string, public status = 422) { super(message); }
}

function problem(reason: string, message: string): never {
	throw new SourceError(message, JSON.stringify({ diagnosticVersion: 1, stage: 'source-configuration', reason }, null, 2));
}

function key() {
	const secret = process.env.BETTER_AUTH_SECRET;
	if (!secret || secret.length < 32) problem('encryption-unavailable', 'Le chiffrement des sources n’est pas disponible.');
	return hkdfSync('sha256', secret, 'TorrentsDuck', 'source-config-v1', 32);
}

function encrypt(config: Config) {
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', key(), iv);
	cipher.setAAD(Buffer.from('source-config-v1'));
	const ciphertext = Buffer.concat([cipher.update(JSON.stringify(config), 'utf8'), cipher.final()]);
	return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.');
}

function decrypt(value: string): Config {
	try {
		const [version, iv, tag, data] = value.split('.');
		if (version !== 'v1') throw new Error();
		const cipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
		cipher.setAAD(Buffer.from('source-config-v1'));
		cipher.setAuthTag(Buffer.from(tag, 'base64url'));
		return JSON.parse(Buffer.concat([cipher.update(Buffer.from(data, 'base64url')), cipher.final()]).toString('utf8'));
	} catch { problem('configuration-unreadable', 'Configuration illisible : retirez puis ajoutez à nouveau la source et ses identifiants.'); }
}

function configuration(input: Record<string, unknown>): { name: string; config: Config; origin: string } {
	if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 100) problem('invalid-name', 'Nom de source requis, limité à 100 caractères.');
	if (typeof input.url !== 'string' || !input.url || input.url.length > 4096 || /[\r\n]/.test(input.url)) problem('invalid-url', 'URL de recherche requise, limitée à 4 096 caractères.');
	const template = input.url.trim().replace(/%7Bquery%7D/gi, '{query}');
	let url: URL;
	try { url = new URL(template.replaceAll('{query}', 'ubuntu')); }
	catch { problem('invalid-url', 'URL de recherche invalide.'); }
	if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || (url.port && !['80', '443'].includes(url.port))) problem('invalid-url', 'Utilisez une URL HTTP(S) publique, sans identifiants intégrés ni fragment.');
	// Keep substitutions in the path/query, never in the destination host.
	if (/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*\{query\}/i.test(template)) problem('invalid-template', 'Le marqueur {query} doit se trouver dans le chemin ou les paramètres de l’URL.');
	const raw = input.auth ?? { type: 'none' };
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) problem('invalid-auth', 'Authentification invalide.');
	const auth = raw as Record<string, unknown>;
	if (!['none', 'basic', 'bearer', 'apiKey'].includes(String(auth.type))) problem('invalid-auth', 'Type d’authentification inconnu.');
	const clean: Auth = { type: auth.type as Auth['type'] };
	if (clean.type === 'basic') {
		for (const field of ['username', 'password'] as const) {
			if (typeof auth[field] !== 'string' || !auth[field] || auth[field].length > 1024 || /[\r\n]/.test(auth[field])) problem('invalid-auth', 'Identifiant et mot de passe requis, limités à 1 024 caractères.');
			clean[field] = auth[field];
		}
		if (clean.username!.includes(':')) problem('invalid-auth', 'L’identifiant HTTP Basic ne peut pas contenir deux-points.');
	} else if (clean.type !== 'none') {
		if (typeof auth.token !== 'string' || !auth.token || auth.token.length > 2048 || /[\r\n]/.test(auth.token)) problem('invalid-auth', 'Jeton ou clé API requis, limité à 2 048 caractères.');
		clean.token = auth.token;
	}
	if (url.protocol !== 'https:' && (clean.type !== 'none' || [...url.searchParams.keys()].some((name) => /key|token|pass|secret|auth/i.test(name)))) problem('https-required', 'HTTPS est requis pour transmettre des identifiants ou une clé API.');
	return { name: input.name.trim(), config: { url: template, auth: clean }, origin: url.origin };
}

function headers(config: Config): Record<string, string> {
	const auth = config.auth;
	if (auth.type === 'basic') return { Authorization: 'Basic ' + Buffer.from(auth.username + ':' + auth.password).toString('base64') };
	if (auth.type === 'bearer') return { Authorization: 'Bearer ' + auth.token };
	if (auth.type === 'apiKey') return { 'X-Api-Key': auth.token! };
	return {};
}

function detection(response: Parameters<typeof detectSourceResponse>[0], config: Config) {
	const detected = detectSourceResponse(response);
	const secrets = [config.auth.username, config.auth.password, config.auth.token,
		...[...new URL(config.url.replaceAll('{query}', 'ubuntu')).searchParams.values()],
		...(config.auth.type === 'basic' ? [Buffer.from(config.auth.username + ':' + config.auth.password).toString('base64')] : [])
	].filter((value): value is string => !!value);
	// A provider may echo an API key in metadata or a JSON field name.
	detected.diagnostic = JSON.stringify(JSON.parse(detected.diagnostic), (_name, value) => {
		if (typeof value !== 'string') return value;
		for (const secret of secrets) value = value === secret ? '[redacted]' : secret.length >= 3 ? value.replaceAll(secret, '[redacted]') : value;
		return value;
	}, 2);
	return detected;
}

function summary(source: Omit<Source, 'config'>) {
	return { id: 'url:' + source.id, name: source.name, url: source.origin, kind: 'url' as const, format: source.format, installed: true, enabled: source.enabled, hasAuth: source.authenticated };
}

export async function urlSources() {
	return (await query<Omit<Source, 'config'>>('SELECT id,name,origin,format,authenticated,enabled FROM search_sources ORDER BY created_at,id')).map(summary);
}

async function sourceById(id: unknown, enabled = false) {
	if (typeof id !== 'string' || !/^url:[a-f0-9-]{36}$/.test(id)) problem('invalid-source', 'Source URL invalide.');
	const [source] = await query<Source>('SELECT id,name,origin,config,format,authenticated,enabled FROM search_sources WHERE id=$1' + (enabled ? ' AND enabled=true' : ''), [id.slice(4)]);
	if (!source) problem('source-unavailable', 'Source introuvable ou désactivée.');
	return source;
}

async function inspect(config: Config, term: string) {
	let response;
	try { response = await fetchSource(config.url.replaceAll('{query}', encodeURIComponent(term)), headers(config), 2 * 1024 * 1024, true); }
	catch (cause) {
		const message = isHttpError(cause) ? cause.body.message : cause instanceof Error ? cause.message : '';
		const reason = /privées|réservées/.test(message) ? 'private-address' : /origine/.test(message) ? 'cross-origin-redirect' : /volumineuse/.test(message) ? 'response-too-large' : /Délai|délai/.test(message) ? 'timeout' : /Hôte/.test(message) ? 'dns-failed' : /Compression|compressée/.test(message) ? 'invalid-compression' : 'request-failed';
		throw new SourceError('La source est inaccessible ou sa réponse a été refusée. Consultez le diagnostic.', JSON.stringify({ diagnosticVersion: 1, stage: 'fetch', reason, origin: new URL(config.url.replaceAll('{query}', 'ubuntu')).origin, authentication: config.auth.type }, null, 2));
	}
	const detected = detection(response, config);
	if (!detected.format) {
		const message = detected.reason === 'http-auth' || detected.reason === 'login' ? 'La source demande une authentification compatible ; vérifiez les identifiants.' : detected.reason === 'captcha' ? 'La source présente une protection antirobot ou demande JavaScript.' : 'Réponse non exploitable. Copiez le diagnostic pour ajouter sa détection.';
		throw new SourceError(message, detected.diagnostic);
	}
	return detected;
}

export async function addUrlSource(input: Record<string, unknown>, userId: string) {
	const { name, config, origin } = configuration(input);
	const encrypted = encrypt(config);
	const detected = await inspect(config, 'ubuntu');
	const id = randomUUID();
	await transaction(async (client) => {
		await client.query('SELECT pg_advisory_xact_lock(782414)');
		const inserted = await client.query('INSERT INTO search_sources(id,name,origin,config,format,authenticated,created_by) SELECT $1,$2,$3,$4,$5,$6,$7 WHERE (SELECT count(*) FROM search_sources)<10 RETURNING id', [id, name, origin, encrypted, detected.format, config.auth.type !== 'none', userId]);
		if (!inserted.rows.length) problem('source-limit', 'Le maximum de 10 sources URL est atteint.');
	});
	return { ok: true, source: summary({ id, name, origin, format: detected.format!, authenticated: config.auth.type !== 'none', enabled: true }), diagnostic: detected.diagnostic };
}

export async function testUrlSource(id: unknown) {
	const source = await sourceById(id);
	const detected = await inspect(decrypt(source.config), 'ubuntu');
	return { ok: true, format: detected.format, resultCount: detected.results.length, diagnostic: detected.diagnostic };
}

export async function changeUrlSource(id: unknown, action: unknown) {
	const source = await sourceById(id);
	if (action === 'uninstall') await query('DELETE FROM search_sources WHERE id=$1', [source.id]);
	else if (action === 'enable' || action === 'disable') await query('UPDATE search_sources SET enabled=$2 WHERE id=$1', [source.id, action === 'enable']);
	else problem('invalid-action', 'Action de source invalide.');
}

export type UrlResult = { result: SourceResult; sourceId: string };
export async function searchUrlSource(id: string, term: string): Promise<UrlResult[]> {
	const source = await sourceById(id, true);
	const config = decrypt(source.config);
	const detected = await inspect(config, term);
	return detected.results.filter((result) => config.url.includes('{query}') || term.toLocaleLowerCase().split(/\s+/).every((word) => result.name.toLocaleLowerCase().includes(word))).map((result) => ({ sourceId: id, result: { ...result, source: source.name } }));
}

export async function downloadUrlResult(value: UrlResult): Promise<string | File> {
	const source = await sourceById(value.sourceId, true);
	if (value.result.url.startsWith('magnet:')) return value.result.url;
	const config = decrypt(source.config);
	const sameOrigin = new URL(value.result.url).origin === source.origin;
	let response;
	try { response = await fetchSource(value.result.url, sameOrigin ? headers(config) : {}, MAX_TORRENT_BYTES, true); }
	catch { problem('torrent-request-failed', 'Impossible de récupérer le torrent. Testez la source depuis la gestion des sources.'); }
	if (response.status !== 200 || response.body[0] !== 100 || response.body.at(-1) !== 101) throw new SourceError('La source n’a pas renvoyé de fichier torrent exploitable.', detection(response, config).diagnostic);
	return new File([new Uint8Array(response.body)], 'source.torrent', { type: 'application/x-bittorrent' });
}
