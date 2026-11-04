import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { error } from '@sveltejs/kit';
import { resolveFile, type Space } from './files';
import { fetchSource } from './network';
import { requireStorage } from './storage';

const maximumImage = 512 * 1024;
const maximumCacheFile = maximumImage * 2;
const maximumEntries = 256;
const day = 86_400_000;
type Cover = { body: Buffer; contentType: string };
type CacheEntry = { expiresAt: number; contentType?: string; image?: string };
// shortcut: cache coordination targets one web process; add shared locks before running replicas.
const pending = new Map<string, Promise<Cover | null>>();
const waiters: (() => void)[] = [];
let active = 0;
let writes = Promise.resolve();

export function movieTitle(filename: string): { title: string; year?: string } | null {
	let title = path.posix.basename(filename).replace(/\.[^.]+$/, '').replace(/^\[[^\]]+\]\s*/, '').replace(/[._]/g, ' ');
	if (/\bS\d{1,2}\s*E\d{1,3}\b|\b\d{1,2}x\d{2}\b/i.test(title)) return null;
	const years = [...title.matchAll(/\b(?:18|19|20)\d{2}\b/g)].filter((match) => Number(match[0]) <= new Date().getFullYear() + 1 && title.slice(0, match.index).replace(/[^\p{L}\p{N}]/gu, '').length > 0);
	const year = years.at(-1);
	if (year) title = title.slice(0, year.index);
	title = title.split(/\b(?:2160p|1080[pi]|720p|480p|bluray|blu-ray|brrip|bdrip|web[ -]?dl|webrip|hdtv|dvdrip|x26[45]|h\s?26[45]|hevc|multi|french|vostfr|truefrench)\b/i)[0].replace(/[()[\]{}]/g, ' ').replace(/\s+/g, ' ').trim();
	return title ? { title, ...(year ? { year: year[0] } : {}) } : null;
}

const normalizedTitle = (title: string) => title.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

async function readCache(filename: string): Promise<CacheEntry | null> {
	try {
		const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			const stat = await handle.stat();
			if (!stat.isFile() || stat.size > maximumCacheFile) return null;
			const entry = JSON.parse(await handle.readFile('utf8')) as CacheEntry;
			return Number.isFinite(entry.expiresAt) && entry.expiresAt > Date.now() ? entry : null;
		} finally { await handle.close(); }
	} catch { return null; }
}

function cachedCover(entry: CacheEntry): Cover | null {
	return typeof entry.image === 'string' && entry.image.length <= maximumCacheFile && ['image/jpeg', 'image/png', 'image/webp'].includes(entry.contentType ?? '')
		? { body: Buffer.from(entry.image, 'base64'), contentType: entry.contentType! } : null;
}

async function writeCache(directory: string, filename: string, entry: CacheEntry) {
	const save = async () => {
		const data = JSON.stringify(entry);
		await requireStorage(Buffer.byteLength(data), directory);
		const files = [];
		for (const name of await readdir(directory)) {
			if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
			try { files.push({ name, modified: (await lstat(path.join(directory, name))).mtimeMs }); }
			catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause; }
		}
		files.sort((a, b) => a.modified - b.modified);
		for (const file of files.slice(0, Math.max(0, files.length - maximumEntries + 1))) await rm(path.join(directory, file.name), { force: true });
		const temporary = path.join(directory, `.cover-${randomUUID()}`);
		try { await writeFile(temporary, data, { flag: 'wx', mode: 0o600 }); await rename(temporary, filename); }
		finally { await rm(temporary, { force: true }); }
	};
	const result = writes.then(save);
	writes = result.catch(() => {});
	await result;
}

async function findCover(movie: NonNullable<ReturnType<typeof movieTitle>>, token: string): Promise<Cover | null> {
	const params = new URLSearchParams({ query: movie.title, language: 'fr-FR', include_adult: 'false', ...(movie.year ? { primary_release_year: movie.year } : {}) });
	const response = await fetchSource(`https://api.themoviedb.org/3/search/movie?${params}`, { authorization: `Bearer ${token}` }, 512 * 1024, true);
	if (response.status !== 200 || response.contentType !== 'application/json') throw new Error('Recherche d’affiche indisponible.');
	const result = JSON.parse(response.body.toString('utf8'));
	if (!Array.isArray(result.results)) throw new Error('Recherche d’affiche invalide.');
	const matches = result.results.filter((item: Record<string, unknown>) => item &&
		['title', 'original_title'].some((field) => typeof item[field] === 'string' && normalizedTitle(item[field]) === normalizedTitle(movie.title)) &&
		(!movie.year || (typeof item.release_date === 'string' && item.release_date.startsWith(`${movie.year}-`))));
	// Ambiguous titles keep the placeholder rather than showing an unrelated remake.
	if (matches.length !== 1 || typeof matches[0].poster_path !== 'string' || !/^\/[a-zA-Z0-9]+\.(?:jpg|png|webp)$/.test(matches[0].poster_path)) return null;
	const image = await fetchSource(`https://image.tmdb.org/t/p/w342${matches[0].poster_path}`, {}, maximumImage, true);
	if (image.status !== 200 || !['image/jpeg', 'image/png', 'image/webp'].includes(image.contentType)) throw new Error('Affiche indisponible.');
	const valid = image.contentType === 'image/jpeg' ? image.body.subarray(0, 3).equals(Buffer.from([255, 216, 255])) :
		image.contentType === 'image/png' ? image.body.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) :
		image.body.subarray(0, 4).toString() === 'RIFF' && image.body.subarray(8, 12).toString() === 'WEBP';
	if (!valid) throw new Error('Format d’affiche invalide.');
	return { body: image.body, contentType: image.contentType };
}

export async function fileCover(space: Space, requested: string): Promise<Cover | null> {
	const file = await resolveFile(space, requested);
	if (!(await lstat(file.absolute)).isFile()) error(400, 'Fichier requis.');
	if (!/\.(mp4|m4v|webm|ogv|mkv|mov|avi|mpeg|mpg|wmv|flv|m2ts|mts|vob|3gp)$/i.test(file.relative)) return null;
	const movie = movieTitle(file.relative);
	const token = process.env.TMDB_READ_ACCESS_TOKEN?.trim();
	if (!movie || !token) return null;
	const directory = path.resolve(process.env.DATA_ROOT ?? './data', 'cache/covers');
	const key = createHash('sha256').update(JSON.stringify({ title: normalizedTitle(movie.title), year: movie.year })).digest('hex');
	const filename = path.join(directory, `${key}.json`);
	const cached = await readCache(filename);
	if (cached) return cachedCover(cached);
	const existing = pending.get(filename);
	if (existing) return existing;
	if (pending.size >= 64) return null;
	const task = (async () => {
		if (active >= 2) await new Promise<void>((resolve) => waiters.push(resolve));
		else active++;
		try {
			await mkdir(directory, { recursive: true, mode: 0o700 });
			if ((await lstat(directory)).isSymbolicLink()) return null;
			await requireStorage(maximumImage * 2, directory);
			let cover: Cover | null = null;
			let lifetime = day;
			try { cover = await findCover(movie, token); if (cover) lifetime = 30 * day; }
			catch { lifetime = 5 * 60_000; }
			await writeCache(directory, filename, { expiresAt: Date.now() + lifetime, ...(cover ? { contentType: cover.contentType, image: cover.body.toString('base64') } : {}) });
			return cover;
		} catch { return null; }
		finally { const next = waiters.shift(); if (next) next(); else active--; }
	})();
	pending.set(filename, task);
	try { return await task; } finally { pending.delete(filename); }
}
