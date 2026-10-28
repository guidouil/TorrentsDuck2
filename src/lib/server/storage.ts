import { statfs } from 'node:fs/promises';
import { error } from '@sveltejs/kit';

export async function storageStatus(directory = process.env.DOWNLOADS_DIR ?? process.env.DATA_ROOT ?? './data') {
	const stats = await statfs(directory);
	const total = stats.blocks * stats.bsize;
	const used = (stats.blocks - stats.bfree) * stats.bsize;
	const available = stats.bavail * stats.bsize;
	const reserved = Math.ceil(total * 0.1);
	return { total, used, available, reserved, usable: Math.max(0, available - reserved), canDownload: available > reserved };
}

export async function requireStorage(bytes = 0, directory?: string) {
	let storage;
	try { storage = await storageStatus(directory); } catch { error(503, 'Volume de données indisponible.'); }
	if (!storage.canDownload || bytes > storage.usable) error(507, 'Marge disque de 10 % atteinte.');
	return storage;
}
