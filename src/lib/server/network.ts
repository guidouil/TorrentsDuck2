import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { error } from '@sveltejs/kit';

export const MAX_TORRENT_BYTES = 8 * 1024 * 1024;

export async function readJson(request: Request): Promise<Record<string, unknown>> {
	if (!request.body) error(400, 'Corps JSON requis.');
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > 16_384) { await reader.cancel(); error(413, 'Requête trop volumineuse.'); }
			chunks.push(value);
		}
	} finally { reader.releaseLock(); }
	let input;
	try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
	catch { error(400, 'JSON invalide.'); }
	if (!input || typeof input !== 'object' || Array.isArray(input)) error(400, 'Objet JSON requis.');
	return input;
}

export function publicAddress(address: string): boolean {
	if (isIP(address) === 4) {
		const [a, b, c] = address.split('.').map(Number);
		return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
			(a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
			(a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
			(a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
			(a === 203 && b === 0 && c === 113));
	}
	// Only global unicast; exclude transition, documentation and special-use ranges.
	if (isIP(address) === 6) {
		const lower = address.toLowerCase();
		const first = parseInt(lower.split(':')[0], 16);
		const second = parseInt(lower.split(':')[1] || '0', 16);
		return first >= 0x2000 && first <= 0x3fff &&
			first !== 0x2002 && !(first === 0x3fff && second < 0x1000) &&
			!(first === 0x2001 && (second < 0x200 || second === 0xdb8));
	}
	return false;
}

export async function fetchTorrent(source: string, redirects = 0): Promise<Buffer> {
	let url: URL;
	try { url = new URL(source); } catch { error(400, 'URL invalide.'); }
	if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
		(url.port && url.port !== '80' && url.port !== '443')) error(400, 'URL HTTP(S) publique requise.');
	const hostname = url.hostname.replace(/^\[|\]$/g, '');
	let addresses;
	try { addresses = await lookup(hostname, { all: true, verbatim: true }); }
	catch { error(400, 'Hôte inaccessible.'); }
	if (!addresses.length || addresses.some(({ address }) => !publicAddress(address))) {
		error(400, 'Les adresses privées ou réservées sont interdites.');
	}
	const pinned = addresses[0];
	return new Promise<Buffer>((resolve, reject) => {
		const request = (url.protocol === 'https:' ? https : http).get(url, {
			signal: AbortSignal.timeout(15_000),
			family: pinned.family,
			headers: { 'user-agent': 'TorrentsDuck/2', accept: 'application/x-bittorrent' },
			// Pin the checked address: a second DNS resolution must not bypass validation.
			lookup: (_host, _options, callback) => callback(null, pinned.address, pinned.family)
		}, (response) => {
			if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
				response.resume();
				if (!response.headers.location || redirects >= 3) return reject(new Error('Trop de redirections.'));
				resolve(fetchTorrent(new URL(response.headers.location, url).href, redirects + 1));
				return;
			}
			if (response.statusCode !== 200) { response.resume(); reject(new Error('Téléchargement du torrent impossible.')); return; }
			let size = 0;
			const chunks: Buffer[] = [];
			response.on('data', (chunk: Buffer) => {
				size += chunk.length;
				if (size > MAX_TORRENT_BYTES) request.destroy(new Error('Fichier torrent trop volumineux.'));
				else chunks.push(chunk);
			});
			response.on('end', () => resolve(Buffer.concat(chunks)));
			response.on('error', reject);
		});
		request.setTimeout(15_000, () => request.destroy(new Error('Délai de téléchargement dépassé.')));
		request.on('error', reject);
	});
}
