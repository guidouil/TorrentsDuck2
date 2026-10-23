import { error, isHttpError } from '@sveltejs/kit';
import { query } from './db';
import { fetchTorrent, MAX_TORRENT_BYTES } from './network';
import { requireStorage } from './storage';

export interface Torrent {
	hash: string; name: string; size: number; progress: number; dlspeed: number; upspeed: number;
	ratio: number; num_leechs: number; num_seeds: number; eta: number; state: string; tags: string;
}

let cookie = '';
let loginPending: Promise<void> | undefined;

function endpoint(path: string) {
	const base = process.env.QBT_URL ?? 'http://127.0.0.1:8080';
	return new URL(`/api/v2/${path}`, base);
}

async function login() {
	if (!loginPending) loginPending = (async () => {
		const response = await fetch(endpoint('auth/login'), {
			method: 'POST', body: new URLSearchParams({ username: process.env.QBT_USERNAME ?? '', password: process.env.QBT_PASSWORD ?? '' }),
			headers: { Referer: new URL('/', endpoint('auth/login')).href }, signal: AbortSignal.timeout(10_000)
		});
		const sid = response.headers.get('set-cookie')?.match(/(?:^|,\s*)SID=([^;]+)/)?.[1];
		if (!response.ok || (await response.text()).trim() !== 'Ok.' || !sid) throw new Error('qBittorrent authentication failed');
		cookie = `SID=${sid}`;
	})().finally(() => { loginPending = undefined; });
	return loginPending;
}

export async function qbt(path: string, body?: URLSearchParams | FormData): Promise<Response> {
	try {
		if (!cookie) await login();
		const send = () => fetch(endpoint(path), {
			method: body ? 'POST' : 'GET', body,
			headers: { Cookie: cookie, Referer: new URL('/', endpoint(path)).href }, signal: AbortSignal.timeout(15_000)
		});
		let response = await send();
		if (response.status === 403) { cookie = ''; await login(); response = await send(); }
		if (!response.ok) throw new Error(`qBittorrent returned ${response.status}`);
		return response;
	} catch (cause) {
		if (isHttpError(cause)) throw cause;
		error(503, 'Le moteur de téléchargement est indisponible.');
	}
}

export async function listTorrents(): Promise<Torrent[]> {
	return (await qbt('torrents/info')).json();
}

export async function addTorrent(input: string | File, userId: string) {
	await requireStorage();
	const form = new FormData();
	if (typeof input === 'string' && input.startsWith('magnet:')) {
		let magnet: URL;
		try { magnet = new URL(input); } catch { error(400, 'Magnet invalide.'); }
		if (!magnet.searchParams.getAll('xt').some((xt) => /^urn:btih:(?:[a-f0-9]{40}|[a-z2-7]{32})$/i.test(xt) || /^urn:btmh:1220[a-f0-9]{64}$/i.test(xt))) {
			error(400, 'Le magnet ne contient pas de hash valide.');
		}
		if (input.length > 16_384) error(400, 'Magnet trop long.');
		form.set('urls', input);
	} else {
		if (typeof input !== 'string' && (input.size === 0 || input.size > MAX_TORRENT_BYTES)) error(400, 'Fichier torrent trop volumineux ou vide.');
		let bytes: Buffer;
		try { bytes = typeof input === 'string' ? await fetchTorrent(input) : Buffer.from(await input.arrayBuffer()); }
		catch (cause) { if (isHttpError(cause)) throw cause; error(400, 'Impossible de récupérer ce fichier torrent.'); }
		if (bytes[0] !== 0x64 || bytes[bytes.length - 1] !== 0x65) error(400, 'Fichier torrent invalide.');
		form.set('torrents', new Blob([new Uint8Array(bytes)]), 'upload.torrent');
	}
	const tag = `duck-author-${Buffer.from(userId).toString('base64url')}`;
	// qBittorrent persists the author tag, so a failed SQL write cannot lose attribution.
	form.set('tags', tag);
	form.set('savepath', process.env.QBT_DOWNLOAD_PATH ?? '/data/downloads');
	form.set('autoTMM', 'false');
	const result = (await (await qbt('torrents/add', form)).text()).trim();
	if (result !== 'Ok.') error(400, 'Le moteur a refusé ce torrent.');
	await syncAuthors(await listTorrents());
	return { ok: true };
}

export async function syncAuthors(torrents: Torrent[]) {
	const hashes: string[] = [];
	const ids: string[] = [];
	for (const torrent of torrents) {
		const tag = torrent.tags?.split(',').map((t) => t.trim()).find((t) => t.startsWith('duck-author-'));
		if (!tag) continue;
		const userId = Buffer.from(tag.slice(12), 'base64url').toString();
		hashes.push(torrent.hash);
		ids.push(userId);
	}
	if (hashes.length) await query('INSERT INTO torrent_authors(hash,user_id) SELECT incoming.hash,u.id FROM unnest($1::text[],$2::text[]) AS incoming(hash,user_id) JOIN "user" u ON u.id=incoming.user_id ON CONFLICT(hash) DO NOTHING', [hashes, ids]);
}

export async function torrentAction(hash: string, action: string, confirm?: boolean) {
	if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(hash)) error(400, 'Hash invalide.');
	if (!['start', 'stop', 'remove', 'delete'].includes(action)) error(400, 'Action invalide.');
	if (action === 'delete' && confirm !== true) error(400, 'Confirmation requise pour effacer les données.');
	const torrent = (await listTorrents()).find((torrent) => torrent.hash === hash);
	if (!torrent) error(404, 'Torrent introuvable.');
	if (action === 'start' && torrent.progress < 1) await requireStorage();
	if (action === 'start' || action === 'stop') await qbt(`torrents/${action}`, new URLSearchParams({ hashes: hash }));
	else {
		await qbt('torrents/delete', new URLSearchParams({ hashes: hash, deleteFiles: String(action === 'delete') }));
		await query('DELETE FROM torrent_authors WHERE hash=$1', [hash]);
	}
	return { ok: true };
}
