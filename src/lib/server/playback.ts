import { createHash, randomBytes } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { error } from '@sveltejs/kit';
import { query } from './db';
import { fileSpace, resolveFile } from './files';

function digest(token: string) { return createHash('sha256').update(token).digest('hex'); }

export async function createPlayback(userId: string, input: Record<string, unknown>, origin: string) {
	const space = fileSpace(input.space);
	const file = await resolveFile(space, input.path);
	if (!(await lstat(file.absolute)).isFile()) error(400, 'Fichier requis.');
	const token = randomBytes(32).toString('base64url');
	const expiresAt = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
	await query('DELETE FROM playback_tokens WHERE expires_at < now() OR revoked_at < now() - interval \'1 day\'');
	const [link] = await query<{ id: string }>('INSERT INTO playback_tokens(token_hash,user_id,space,path,expires_at) VALUES($1,$2,$3,$4,$5) RETURNING id', [digest(token), userId, space, file.relative, expiresAt]);
	return { id: link.id, token, url: `${origin}/api/files/play/${token}`, expiresAt };
}

export async function revokePlayback(userId: string, input: Record<string, unknown>) {
	if (typeof input.id !== 'string' && typeof input.token !== 'string') error(400, 'Identifiant requis.');
	const rows = await query('UPDATE playback_tokens SET revoked_at=now() WHERE user_id=$1 AND (id=$2 OR token_hash=$3) RETURNING id', [userId, input.id ?? '', typeof input.token === 'string' ? digest(input.token) : '']);
	if (!rows.length) error(404, 'Lien introuvable.');
	return { ok: true };
}

export async function playbackFile(token: string) {
	if (!/^[A-Za-z0-9_-]{43}$/.test(token)) error(404, 'Lien introuvable.');
	const [row] = await query<{ space: 'downloads' | 'share'; path: string }>(
		'SELECT p.space,p.path FROM playback_tokens p JOIN "user" u ON u.id=p.user_id WHERE p.token_hash=$1 AND p.revoked_at IS NULL AND p.expires_at>now() AND u.enabled=true AND u.approved=true', [digest(token)]
	);
	if (!row) error(404, 'Lien expiré ou révoqué.');
	return row;
}
