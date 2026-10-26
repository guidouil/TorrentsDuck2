import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rm, link, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import { error } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import busboy from 'busboy';
import { requireStorage } from './storage';
import type { Member } from './permissions';

const run = promisify(execFile);

export type Space = 'downloads' | 'share';

export function fileSpace(value: unknown): Space {
	if (value !== 'downloads' && value !== 'share') error(400, 'Espace invalide.');
	return value;
}

export function relativePath(value: unknown): string {
	if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u001f\u007f\\]/.test(value) || path.posix.isAbsolute(value) || value.split('/').some((part) => part === '..' || part === '.')) {
		error(400, 'Chemin invalide.');
	}
	return value.replace(/\/+$/g, '');
}

export function fileName(value: unknown): string {
	const name = relativePath(value);
	if (!name || name.includes('/') || Buffer.byteLength(name) > 255 || name.startsWith('.duck-upload-')) error(400, 'Nom invalide.');
	return name;
}

export function rootPath(space: Space): string {
	return path.resolve(space === 'downloads' ? (process.env.DOWNLOADS_DIR ?? './data/downloads') : (process.env.SHARE_DIR ?? './data/share'));
}

export async function resolveFile(space: Space, requested: unknown, missing = false) {
	const relative = relativePath(requested);
	const root = await realpath(rootPath(space));
	const parts = relative.split('/').filter(Boolean);
	let current = root;
	for (let i = 0; i < parts.length; i++) {
		current = path.join(current, parts[i]);
		try {
			const stat = await lstat(current);
			if (stat.isSymbolicLink()) error(403, 'Les liens symboliques sont interdits.');
			if (i < parts.length - 1 && !stat.isDirectory()) error(404, 'Dossier introuvable.');
		} catch (cause) {
			if ((cause as NodeJS.ErrnoException).code === 'ENOENT' && missing && i === parts.length - 1) return { absolute: current, relative, root };
			if ((cause as NodeJS.ErrnoException).code === 'ENOENT') error(404, 'Fichier introuvable.');
			throw cause;
		}
	}
	return { absolute: current, relative, root };
}

export async function listFiles(space: Space, requested: string, options: URLSearchParams) {
	const directory = await resolveFile(space, requested);
	if (!(await lstat(directory.absolute)).isDirectory()) error(400, 'Ce chemin est un fichier.');
	const search = (options.get('search') ?? '').toLocaleLowerCase();
	const entries = [];
	for (const dirent of await readdir(directory.absolute, { withFileTypes: true })) {
		if (dirent.isSymbolicLink() || dirent.name.startsWith('.duck-upload-') || !dirent.name.toLocaleLowerCase().includes(search)) continue;
		try {
			const stat = await lstat(path.join(directory.absolute, dirent.name));
			if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) continue;
			entries.push({ name: dirent.name, path: path.posix.join(directory.relative, dirent.name), directory: stat.isDirectory(), size: stat.size, modifiedAt: stat.mtime.toISOString() });
		} catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause; }
	}
	const sort = options.get('sort') ?? 'modifiedAt';
	const direction = (options.get('order') ?? (sort === 'modifiedAt' ? 'desc' : 'asc')) === 'desc' ? -1 : 1;
	entries.sort((a, b) => Number(b.directory) - Number(a.directory) || direction * (sort === 'size' ? a.size - b.size : sort === 'modifiedAt' ? a.modifiedAt.localeCompare(b.modifiedAt) : a.name.localeCompare(b.name)));
	const offset = Math.max(0, Math.min(Number(options.get('offset')) || 0, entries.length));
	const limit = Math.max(1, Math.min(Number(options.get('limit')) || 100, 500));
	return { space, path: directory.relative, entries: entries.slice(offset, offset + limit), total: entries.length, offset, limit };
}

export async function changeFiles(input: Record<string, unknown>, role: Member['role'] = 'member') {
	const space = fileSpace(input.space);
	if (space === 'downloads' && (role !== 'admin' || input.action !== 'delete')) error(403, 'Seuls les administrateurs peuvent supprimer les téléchargements.');
	const source = await resolveFile(space, input.path ?? '');
	if (input.action === 'mkdir') {
		if (!(await lstat(source.absolute)).isDirectory()) error(400, 'Dossier requis.');
		const destination = await resolveFile(space, path.posix.join(source.relative, fileName(input.name)), true);
		try { await mkdir(destination.absolute, { mode: 0o2770 }); }
		catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'EEXIST') error(409, 'Ce nom existe déjà.'); throw cause; }
	} else if (input.action === 'rename') {
		if (!source.relative) error(403, 'Impossible de renommer la racine.');
		const destination = await resolveFile(space, path.posix.join(path.posix.dirname(source.relative) === '.' ? '' : path.posix.dirname(source.relative), fileName(input.name)), true);
		await moveWithoutReplacement(source.absolute, destination.absolute);
	} else if (input.action === 'delete') {
		if (!source.relative || input.confirm !== true) error(400, 'Confirmation requise pour supprimer.');
		await rm(source.absolute, { recursive: true });
	} else error(400, 'Action invalide.');
	return { ok: true };
}

export async function moveWithoutReplacement(source: string, destination: string) {
	if (process.platform !== 'linux' && process.platform !== 'darwin') error(503, 'Renommage disponible sur Debian et macOS.');
	try { await lstat(destination); error(409, 'Ce nom existe déjà.'); }
	catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause; }
	const original = await lstat(source);
	const options = process.platform === 'linux' ? ['--no-clobber', '--no-copy', '--no-target-directory', '--'] : ['-n'];
	// GNU mv uses renameat2(RENAME_NOREPLACE), preserving files concurrently uploaded over FTPS.
	// shortcut: macOS mv is only for local development; concurrent FTPS mutations require the Debian deployment.
	await run('mv', [...options, source, destination], { timeout: 10_000 });
	const result = await lstat(destination);
	if (result.ino !== original.ino || result.dev !== original.dev) error(409, 'Ce nom existe déjà.');
}

export async function uploadFile(event: RequestEvent) {
	const space = fileSpace(event.url.searchParams.get('space') ?? 'share');
	if (space !== 'share') error(403, 'Les téléchargements sont en lecture seule.');
	// Metadata belongs in the URL so the destination is checked before streaming the first byte.
	const directory = await resolveFile(space, event.url.searchParams.get('path') ?? '');
	if (!(await lstat(directory.absolute)).isDirectory()) error(400, 'Dossier requis.');
	const available = (await requireStorage()).usable;
	if (Number(event.request.headers.get('content-length') ?? 0) > available) error(507, 'Marge disque insuffisante.');
	const temp = path.join(directory.absolute, `.duck-upload-${randomUUID()}`);
	const handle = await open(temp, 'wx', 0o660);
	let uploaded: Promise<void> | undefined;
	let name = '';
	try {
		await new Promise<void>((resolve, reject) => {
			const parser = busboy({ headers: Object.fromEntries(event.request.headers), limits: { files: 1, fields: 4, fieldSize: 4096, fileSize: available, parts: 5 } });
			if (!event.request.body) return reject(new Error('Fichier requis.'));
			const input = Readable.fromWeb(event.request.body as never);
			let rejected = false;
			let currentFile: NodeJS.ReadableStream & { destroy(error?: Error): void };
			function fail(cause: unknown) {
				if (rejected) return;
				rejected = true;
				input.destroy();
				currentFile?.destroy();
				parser.destroy();
				reject(cause);
			}
			parser.on('file', (field, stream, info) => {
				currentFile = stream;
				try {
					if (field !== 'file') error(400, 'Champ file requis.');
					name = fileName(info.filename);
					stream.on('limit', () => fail(new Error('Marge disque atteinte.')));
					let sinceCheck = 0;
					const reserve = new Transform({
						transform(chunk: Buffer, _encoding, callback) {
							sinceCheck += chunk.length;
							if (sinceCheck < 8 * 1024 * 1024) return callback(null, chunk);
							sinceCheck = 0;
							void requireStorage(chunk.length).then(() => callback(null, chunk), (cause) => callback(cause));
						}
					});
					uploaded = pipeline(stream, reserve, handle.createWriteStream({ autoClose: true, flush: true }));
					uploaded.catch(fail);
				} catch (cause) { fail(cause); }
			});
			parser.on('field', (field, value) => {
				if ((field === 'space' && value !== space) || (field === 'path' && value !== directory.relative) || (field === 'action' && value !== 'upload')) fail(new Error('Métadonnées incohérentes.'));
			});
			for (const limit of ['filesLimit', 'fieldsLimit', 'partsLimit']) parser.on(limit, () => fail(new Error('Trop de champs.')));
			parser.on('error', fail);
			parser.on('close', resolve);
			pipeline(input, parser).catch(fail);
		});
		if (!uploaded || !name) error(400, 'Fichier requis.');
		await uploaded;
		await requireStorage();
		const destination = await resolveFile(space, path.posix.join(directory.relative, name), true);
		// link() publishes a complete file atomically and refuses to replace existing data.
		try { await link(temp, destination.absolute); }
		catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'EEXIST') error(409, 'Ce nom existe déjà.'); throw cause; }
		return { ok: true, name, path: destination.relative };
	} finally {
		await uploaded?.catch(() => {});
		await handle.close().catch(() => {});
		await unlink(temp).catch(() => {});
	}
}

export function byteRange(header: string | null, size: number): { start: number; end: number } | null {
	if (!header) return null;
	const match = /^bytes=(\d*)-(\d*)$/.exec(header);
	if (!match || (!match[1] && !match[2]) || size === 0) error(416, 'Plage invalide.');
	let start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
	const end = match[1] ? (match[2] ? Math.min(Number(match[2]), size - 1) : size - 1) : size - 1;
	if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= size || (!match[1] && Number(match[2]) === 0)) error(416, 'Plage invalide.');
	return { start, end };
}

export async function downloadFile(event: RequestEvent, space: Space, requested: string, inline = false) {
	const file = await resolveFile(space, requested);
	const handle = await open(file.absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
	const stat = await handle.stat();
	if (!stat.isFile()) { await handle.close(); error(400, 'Fichier requis.'); }
	const extension = path.extname(file.relative).toLowerCase();
	const media: Record<string, string> = { '.mp4': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo', '.mov': 'video/quicktime', '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.png': 'image/png' };
	const headers = new Headers({
		'content-type': media[extension] ?? 'application/octet-stream', 'accept-ranges': 'bytes',
		'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(path.basename(file.relative))}`,
		'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff'
	});
	if (process.env.FILE_DELIVERY === 'nginx') {
		await handle.close();
		headers.set('x-accel-redirect', `/_protected/${space}/${file.relative.split('/').map(encodeURIComponent).join('/')}`);
		return new Response(null, { headers });
	}
	let range;
	try { range = byteRange(event.request.headers.get('range'), stat.size); }
	catch { await handle.close(); return new Response(null, { status: 416, headers: { 'content-range': `bytes */${stat.size}` } }); }
	const start = range?.start ?? 0;
	const end = range?.end ?? Math.max(0, stat.size - 1);
	headers.set('content-length', String(range ? end - start + 1 : stat.size));
	if (range) headers.set('content-range', `bytes ${start}-${end}/${stat.size}`);
	if (event.request.method === 'HEAD' || stat.size === 0) { await handle.close(); return new Response(null, { status: range ? 206 : 200, headers }); }
	const stream = handle.createReadStream({ start, end, autoClose: true });
	return new Response(Readable.toWeb(stream) as ReadableStream, { status: range ? 206 : 200, headers });
}
