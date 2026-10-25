import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';
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

async function publicDestination(source: string, signal?: AbortSignal) {
	let url: URL;
	try { url = new URL(source); } catch { error(400, 'URL invalide.'); }
	if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
		(url.port && url.port !== '80' && url.port !== '443')) error(400, 'URL HTTP(S) publique requise.');
	const hostname = url.hostname.replace(/^\[|\]$/g, '');
	let addresses;
	try {
		const resolution = lookup(hostname, { all: true, verbatim: true });
		addresses = signal ? await new Promise<Awaited<typeof resolution>>((resolve, reject) => {
			const abort = () => reject(new Error('Délai de résolution dépassé.'));
			resolution.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
			if (signal.aborted) abort();
			else signal.addEventListener('abort', abort, { once: true });
		}) : await resolution;
	}
	catch { error(400, 'Hôte inaccessible.'); }
	if (!addresses.length || addresses.some(({ address }) => !publicAddress(address))) {
		error(400, 'Les adresses privées ou réservées sont interdites.');
	}
	return { url, pinned: addresses[0] };
}

export async function fetchTorrent(source: string, redirects = 0): Promise<Buffer> {
	const { url, pinned } = await publicDestination(source);
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

export async function fetchSource(source: string, headers: Record<string, string> = {}, maximum = 2 * 1024 * 1024, sameOriginOnly = false): Promise<{ url: string; status: number; contentType: string; body: Buffer }> {
	if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > MAX_TORRENT_BYTES) error(400, 'Limite de réponse de source invalide.');
	const credentials: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers)) {
		if (!['authorization', 'x-api-key'].includes(name.toLowerCase()) || typeof value !== 'string' || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) error(400, 'En-tête de source invalide.');
		credentials[name.toLowerCase()] = value;
	}
	const authenticated = Object.keys(credentials).length > 0;
	const deadline = AbortSignal.timeout(30_000);
	async function visit(destination: string, redirects: number): Promise<{ url: string; status: number; contentType: string; body: Buffer }> {
		const signal = AbortSignal.any([deadline, AbortSignal.timeout(10_000)]);
		let parsed: URL;
		try { parsed = new URL(destination); } catch { error(400, 'URL invalide.'); }
		if (authenticated && parsed.protocol !== 'https:') error(400, 'HTTPS est requis pour les identifiants de source.');
		const { url, pinned } = await publicDestination(destination, signal);
		return new Promise((resolve, reject) => {
			let failed = false;
			const fail = (message: string) => { failed = true; reject(new Error(message)); };
			let request: http.ClientRequest;
			try {
				request = (url.protocol === 'https:' ? https : http).get(url, {
					signal, family: pinned.family,
					headers: { 'user-agent': 'TorrentsDuck/2', accept: 'application/json, application/rss+xml, application/atom+xml, application/xml, text/html, text/plain;q=0.5', 'accept-encoding': 'gzip, br, deflate', ...credentials },
					lookup: (_host, _options, callback) => callback(null, pinned.address, pinned.family)
				}, (response) => {
					if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
						response.destroy();
						if (!response.headers.location || redirects >= 3) { fail('Trop de redirections pour la source.'); return; }
						let next: URL;
						try { next = new URL(response.headers.location, url); } catch { fail('Redirection de source invalide.'); return; }
						if ((authenticated || sameOriginOnly) && next.origin !== url.origin) { fail('Redirection vers une autre origine refusée pour protéger les identifiants.'); return; }
						resolve(visit(next.href, redirects + 1));
						return;
					}
					let size = 0;
					const chunks: Buffer[] = [];
					response.on('data', (chunk: Buffer) => {
						if (failed) return;
						size += chunk.length;
						if (size > maximum) { fail('Réponse de source trop volumineuse.'); request.destroy(); }
						else chunks.push(chunk);
					});
					response.on('end', () => {
						if (failed) return;
						let body = Buffer.concat(chunks);
						const encoding = String(response.headers['content-encoding'] ?? 'identity').trim().toLowerCase();
						try {
							if (encoding === 'gzip') body = gunzipSync(body, { maxOutputLength: maximum });
							else if (encoding === 'br') body = brotliDecompressSync(body, { maxOutputLength: maximum });
							else if (encoding === 'deflate') body = inflateSync(body, { maxOutputLength: maximum });
							else if (encoding !== 'identity') { fail('Compression de source non prise en charge.'); return; }
						} catch { fail('Réponse compressée invalide ou trop volumineuse.'); return; }
						resolve({ url: url.href, status: response.statusCode ?? 0, contentType: String(response.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase(), body });
					});
					response.on('error', () => fail('Lecture de la réponse de source impossible.'));
					response.on('aborted', () => fail('Réponse de source interrompue.'));
				});
			} catch { fail('La requête vers la source a échoué.'); return; }
			request.on('error', () => fail(signal.aborted ? 'Délai de source dépassé.' : 'La source est inaccessible.'));
		});
	}
	return visit(source, 0);
}
