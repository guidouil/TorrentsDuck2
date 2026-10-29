import { constants, type Stats } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, rm, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { error, type RequestEvent } from '@sveltejs/kit';
import { parseStudioSrt, STUDIO_MAX_SECONDS, studioDuration, type StudioClip, type StudioDubbing, type StudioEdit, type StudioJob, type StudioJobInput, type StudioJobKind, type StudioProject, type StudioSource } from '../studio';
import { query, transaction } from './db';
import { fileName, fileResponse, fileSpace, relativePath, resolveFile } from './files';
import { requireStorage } from './storage';
import { audit } from './audit';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const videos = /\.(mp4|m4v|webm|ogv|mkv|mov|avi|mpeg|mpg|wmv|flv|m2ts|mts|vob|3gp)$/i;
type ProjectRow = { id: string; edit: StudioEdit; createdAt: Date; updatedAt: Date };
const projectFields = 'id,edit,created_at AS "createdAt",updated_at AS "updatedAt"';
const jobFields = 'id,project_id AS "projectId",kind,status,progress,error,result,input->\'dubbing\' AS dubbing,created_at AS "createdAt",updated_at AS "updatedAt"';

export function studioId(value: unknown): string {
	if (typeof value !== 'string' || !uuid.test(value)) error(404, 'Projet ou tâche introuvable.');
	return value;
}

function sourceInput(value: unknown): StudioSource {
	if (!value || typeof value !== 'object' || Array.isArray(value)) error(400, 'Vidéo requise.');
	const input = value as Record<string, unknown>;
	const space = fileSpace(input.space), sourcePath = relativePath(input.path);
	if (!sourcePath || !videos.test(sourcePath)) error(400, 'Fichier vidéo requis.');
	return { space, path: sourcePath };
}

export function validateStudioDubbing(value: unknown): StudioDubbing {
	if (!value || typeof value !== 'object' || Array.isArray(value)) error(400, 'Lien YouTube et décalage audio requis.');
	const input = value as Record<string, unknown>;
	if (typeof input.url !== 'string' || input.url.length > 2048) error(400, 'Lien YouTube invalide.');
	let url: URL;
	try { url = new URL(input.url); } catch { error(400, 'Lien YouTube invalide.'); }
	if (url.protocol !== 'https:' || url.username || url.password || url.port ||
		!['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'].includes(url.hostname)) error(400, 'Lien HTTPS YouTube requis.');
	const video = url.hostname === 'youtu.be' ? url.pathname.slice(1) :
		url.pathname === '/watch' ? url.searchParams.get('v') : /^\/(?:shorts|live|embed)\/([^/]+)$/.exec(url.pathname)?.[1];
	if (!video || !/^[a-zA-Z0-9_-]{11}$/.test(video)) error(400, 'Lien vers une seule vidéo YouTube requis.');
	if (typeof input.offset !== 'number' || !Number.isFinite(input.offset) || Math.abs(input.offset) > 600) error(400, 'Décalage audio requis entre −600 et 600 secondes.');
	if (input.audioJobId !== undefined) studioId(input.audioJobId);
	return { url: `https://www.youtube.com/watch?v=${video}`, offset: input.offset, ...(input.audioJobId !== undefined ? { audioJobId: input.audioJobId as string } : {}) };
}

export function validateStudioEdit(input: Record<string, unknown>): StudioEdit {
	if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 100 || /[\u0000-\u001f\u007f]/.test(input.name)) error(400, 'Nom de projet invalide.');
	if (input.aspect !== '16:9' && input.aspect !== '9:16') error(400, 'Format vidéo invalide.');
	if (!Array.isArray(input.clips) || input.clips.length > 32) error(400, 'Le montage accepte au plus 32 extraits.');
	const clips = input.clips.map((value): StudioClip => {
		const source = sourceInput(value), clip = value as Record<string, unknown>;
		for (const key of ['start', 'end', 'x', 'y'] as const) if (typeof clip[key] !== 'number' || !Number.isFinite(clip[key])) error(400, 'Réglage vidéo invalide.');
		const start = clip.start as number, end = clip.end as number, x = clip.x as number, y = clip.y as number;
		if (start < 0 || end <= start || end > 86400 || x < 0 || x > 1 || y < 0 || y > 1) error(400, 'Découpe ou cadrage invalide.');
		if (clip.audio !== null && (!Number.isInteger(clip.audio) || (clip.audio as number) < 0 || (clip.audio as number) > 127)) error(400, 'Piste audio invalide.');
		if (typeof clip.title !== 'string' || clip.title.length > 140 || /[\u0000-\u001f\u007f]/.test(clip.title)) error(400, 'Titre invalide.');
		if (typeof clip.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(clip.fingerprint)) error(400, 'Analyser la source avant de l’ajouter.');
		return { ...source, start, end, x, y, audio: clip.audio as number | null, title: clip.title, fingerprint: clip.fingerprint };
	});
	const duration = studioDuration(clips);
	if (duration > STUDIO_MAX_SECONDS + 0.000001) error(400, 'Le montage ne peut pas dépasser 5 minutes.');
	if (typeof input.subtitles !== 'string') error(400, 'Sous-titres invalides.');
	try { parseStudioSrt(input.subtitles, duration); } catch (cause) { error(400, (cause as Error).message); }
	return { name: input.name.trim(), aspect: input.aspect, clips, subtitles: input.subtitles };
}

export function studioRoot() { return path.resolve(process.env.STUDIO_DIR ?? path.join(process.env.DATA_ROOT ?? './data', 'studio')); }

export async function studioJobDirectory(id: string) {
	studioId(id);
	const root = studioRoot();
	await mkdir(root, { recursive: true, mode: 0o755 });
	const rootStat = await lstat(root);
	if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) error(403, 'Volume Studio invalide.');
	const directory = path.join(root, id);
	await mkdir(directory, { recursive: true, mode: 0o755 });
	const stat = await lstat(directory);
	if (!stat.isDirectory() || stat.isSymbolicLink()) error(403, 'Dossier Studio invalide.');
	return directory;
}

export async function studioOutput(id: string, kind: StudioJobKind) {
	if (kind === 'probe') error(400, 'Cette tâche ne produit pas de fichier.');
	return path.join(await studioJobDirectory(id), kind === 'thumbnail' ? 'output.jpg' : kind === 'dub-audio' ? 'output.m4a' : kind === 'dub' ? 'output.mkv' : 'output.mp4');
}

export const studioFingerprint = (stat: Pick<Stats, 'dev' | 'ino' | 'size' | 'mtimeMs' | 'ctimeMs'>) => createHash('sha256').update(`${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`).digest('hex');

export async function sourceFingerprint(source: StudioSource) {
	const file = await resolveFile(fileSpace(source.space), relativePath(source.path));
	const stat = await lstat(file.absolute);
	if (!stat.isFile() || stat.isSymbolicLink()) error(400, 'Fichier vidéo requis.');
	return { absolute: file.absolute, fingerprint: studioFingerprint(stat) };
}

export async function requireStudioStorage(bytes = 0): Promise<void> {
	await requireStorage(bytes, studioRoot());
}

function project(row: ProjectRow): StudioProject {
	return { ...row.edit, id: row.id, createdAt: new Date(row.createdAt).toISOString(), updatedAt: new Date(row.updatedAt).toISOString() };
}

export async function studioProjects(userId: string) {
	return (await query<ProjectRow>(`SELECT ${projectFields} FROM studio_projects WHERE user_id=$1 ORDER BY updated_at DESC,id`, [userId])).map(project);
}

export async function ownedStudioProject(userId: string, id: string) {
	const [row] = await query<ProjectRow>(`SELECT ${projectFields} FROM studio_projects WHERE id=$1 AND user_id=$2`, [studioId(id), userId]);
	if (!row) error(404, 'Projet introuvable.');
	return project(row);
}

export async function createStudioProject(userId: string, name: unknown) {
	const edit = validateStudioEdit({ name, aspect: '16:9', clips: [], subtitles: '' });
	const row = await transaction(async (client) => {
		await client.query('SELECT pg_advisory_xact_lock(782414,hashtext($1))', [userId]);
		const { rows: [count] } = await client.query('SELECT count(*)::int AS count FROM studio_projects WHERE user_id=$1', [userId]);
		if (count.count >= 100) error(429, 'Limite de 100 projets atteinte.');
		const { rows: [created] } = await client.query<ProjectRow>(`INSERT INTO studio_projects(user_id,edit) VALUES($1,$2) RETURNING ${projectFields}`, [userId, JSON.stringify(edit)]);
		return created;
	});
	await audit(userId, 'studio.create', {}, row.id);
	return project(row);
}

export async function updateStudioProject(userId: string, id: string, input: Record<string, unknown>) {
	const edit = validateStudioEdit(input);
	const [row] = await query<ProjectRow>(`UPDATE studio_projects SET edit=$3,updated_at=now() WHERE id=$1 AND user_id=$2 RETURNING ${projectFields}`, [studioId(id), userId, JSON.stringify(edit)]);
	if (!row) error(404, 'Projet introuvable.');
	return project(row);
}

export async function studioJobs(userId: string, projectId: string) {
	return query<StudioJob>(`SELECT ${jobFields} FROM studio_jobs WHERE project_id=$1 AND user_id=$2 ORDER BY created_at DESC,id DESC`, [studioId(projectId), userId]);
}

export async function ownedStudioJob(userId: string, projectId: string, id: string) {
	const [job] = await query<StudioJob>(`SELECT ${jobFields} FROM studio_jobs WHERE id=$1 AND project_id=$2 AND user_id=$3`, [studioId(id), studioId(projectId), userId]);
	if (!job) error(404, 'Tâche introuvable.');
	return job;
}

export async function createStudioJob(userId: string, projectId: string, input: Record<string, unknown>) {
	const edit = await ownedStudioProject(userId, projectId);
	const kind = input.kind;
	if (kind !== 'probe' && kind !== 'thumbnail' && kind !== 'preview' && kind !== 'export' && kind !== 'dub-audio' && kind !== 'dub') error(400, 'Tâche invalide.');
	const snapshot: StudioJobInput = { project: validateStudioEdit(edit) };
	if (kind === 'dub' || kind === 'dub-audio') snapshot.dubbing = validateStudioDubbing(input.dubbing);
	if (kind === 'dub-audio') snapshot.dubbing = { url: snapshot.dubbing!.url, offset: 0 };
	if (kind === 'probe' || kind === 'thumbnail' || kind === 'dub') {
		snapshot.source = sourceInput(input.source);
		snapshot.fingerprint = (await sourceFingerprint(snapshot.source)).fingerprint;
		if (kind === 'thumbnail') {
			if (typeof input.time !== 'number' || !Number.isFinite(input.time) || input.time < 0 || input.time > 86400) error(400, 'Timecode invalide.');
			snapshot.time = input.time;
		}
	} else if (kind !== 'dub-audio') {
		if (!snapshot.project.clips.length) error(400, 'Ajouter au moins un extrait.');
		for (const clip of snapshot.project.clips) {
			if ((await sourceFingerprint(clip)).fingerprint !== clip.fingerprint) error(409, 'Une source a changé. Analyser à nouveau la vidéo.');
		}
	}
	const id = randomUUID();
	await studioJobDirectory(id);
	try {
		await requireStudioStorage();
		if (kind === 'dub' && snapshot.dubbing?.audioJobId) {
			const prepared = await ownedStudioJob(userId, projectId, snapshot.dubbing.audioJobId);
			if (prepared.kind !== 'dub-audio' || prepared.status !== 'completed' || prepared.dubbing?.url !== snapshot.dubbing.url) error(400, 'Bande son YouTube préparée requise pour ce lien.');
			const audio = await studioOutput(prepared.id, 'dub-audio');
			try {
				const original = await lstat(audio);
				if (!original.isFile() || original.isSymbolicLink()) error(403, 'Bande son invalide.');
				// A private hard link keeps queued exports valid if the preparation is later deleted.
				await link(audio, path.join(studioRoot(), id, 'audio.m4a'));
				const stat = await lstat(path.join(studioRoot(), id, 'audio.m4a'));
				if (!stat.isFile() || stat.isSymbolicLink() || stat.dev !== original.dev || stat.ino !== original.ino) error(403, 'Bande son invalide.');
			} catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ENOENT') error(404, 'Bande son introuvable. Téléchargez-la à nouveau.'); throw cause; }
		}
		return await transaction(async (client) => {
			await client.query('SELECT pg_advisory_xact_lock(782414,hashtext($1))', [userId]);
			const { rows: [counts] } = await client.query(`SELECT count(*) FILTER (WHERE status IN ('queued','running'))::int AS active,count(*) FILTER (WHERE project_id=$2)::int AS total FROM studio_jobs WHERE user_id=$1`, [userId, projectId]);
			if (counts.active >= 10 || counts.total >= 100) error(429, 'Supprimer des tâches terminées ou attendre les rendus en cours.');
			const { rows: [row] } = await client.query<StudioJob>(`INSERT INTO studio_jobs(id,project_id,user_id,kind,input) SELECT $1,id,user_id,$4,$5 FROM studio_projects WHERE id=$2 AND user_id=$3 RETURNING ${jobFields}`, [id, projectId, userId, kind, JSON.stringify(snapshot)]);
			if (!row) error(404, 'Projet introuvable.');
			return row;
		});
	} catch (cause) { await rm(path.join(studioRoot(), id), { recursive: true, force: true }); throw cause; }
}

export async function deleteStudioJob(userId: string, projectId: string, id: string, confirm: unknown) {
	const job = await ownedStudioJob(userId, projectId, id);
	if (job.status === 'queued' || job.status === 'running') {
		const cancelled = await query("UPDATE studio_jobs SET cancel_requested=true,status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END,updated_at=now() WHERE id=$1 AND user_id=$2 AND status IN ('queued','running') RETURNING id", [id, userId]);
		if (!cancelled.length) error(409, 'Le rendu vient de terminer. Actualiser avant de le supprimer.');
		return { ok: true };
	}
	if (confirm !== true) error(400, 'Confirmer la suppression du rendu privé.');
	await query('DELETE FROM studio_jobs WHERE id=$1 AND user_id=$2', [id, userId]);
	await rm(path.join(studioRoot(), studioId(id)), { recursive: true, force: true });
	return { ok: true };
}

export async function deleteStudioProject(userId: string, id: string, confirm: unknown) {
	if (confirm !== true) error(400, 'Confirmer la suppression du projet et de ses rendus privés.');
	await ownedStudioProject(userId, id);
	const jobs = await studioJobs(userId, id);
	await query('DELETE FROM studio_projects WHERE id=$1 AND user_id=$2', [id, userId]);
	// The worker stops deleted running jobs and removes their working directory.
	for (const job of jobs) if (job.status !== 'running') await rm(path.join(studioRoot(), studioId(job.id)), { recursive: true, force: true });
	await audit(userId, 'studio.delete', {}, id);
	return { ok: true };
}

export async function studioFile(event: RequestEvent, userId: string, projectId: string, id: string) {
	const job = await ownedStudioJob(userId, projectId, id);
	if (job.status !== 'completed' || job.kind === 'probe') error(404, 'Rendu indisponible.');
	const absolute = await studioOutput(id, job.kind);
	try {
		return await fileResponse(event, absolute, path.basename(absolute), event.url.searchParams.get('inline') === '1', `/_protected/studio/${id}/${path.basename(absolute)}`);
	} catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ENOENT') error(404, 'Rendu introuvable.'); throw cause; }
}

export async function publishStudioJob(userId: string, projectId: string, id: string, input: Record<string, unknown>) {
	if (input.confirm !== true) error(400, 'Confirmer le partage avec la communauté.');
	const job = await ownedStudioJob(userId, projectId, id);
	if (job.status !== 'completed' || (job.kind !== 'export' && job.kind !== 'dub')) error(400, 'Export terminé requis.');
	const name = fileName(input.name);
	const extension = job.kind === 'dub' ? '.mkv' : '.mp4';
	if (!name.toLowerCase().endsWith(extension)) error(400, `Nom ${extension.slice(1).toUpperCase()} requis.`);
	const destination = await resolveFile('share', name, true), directory = await resolveFile('share', '');
	const temp = path.join(directory.absolute, `.duck-upload-${randomUUID()}`);
	const source = await open(await studioOutput(id, job.kind), constants.O_RDONLY | constants.O_NOFOLLOW);
	let target;
	try {
		const stat = await source.stat();
		if (!stat.isFile()) error(400, 'Export invalide.');
		await requireStorage(stat.size, directory.absolute);
		target = await open(temp, 'wx', 0o644);
		let sinceCheck = 0;
		const reserve = new Transform({ transform(chunk: Buffer, _encoding, callback) {
			sinceCheck += chunk.length;
			if (sinceCheck < 8 * 1024 * 1024) return callback(null, chunk);
			sinceCheck = 0;
			void requireStorage(chunk.length, directory.absolute).then(() => callback(null, chunk), callback);
		} });
		await pipeline(source.createReadStream(), reserve, target.createWriteStream({ flush: true }));
		await requireStorage(0, directory.absolute);
		const [allowed] = await query('SELECT j.id FROM studio_jobs j JOIN "user" u ON u.id=j.user_id WHERE j.id=$1 AND j.user_id=$2 AND u.enabled=true AND u.approved=true', [id, userId]);
		if (!allowed) error(403, 'Accès révoqué ou export supprimé.');
		try { await link(temp, destination.absolute); }
		catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'EEXIST') error(409, 'Ce nom existe déjà.'); throw cause; }
		await audit(userId, 'studio.publish', { name }, id);
		return { path: destination.relative };
	} finally {
		await source.close().catch(() => {});
		await target?.close().catch(() => {});
		await unlink(temp).catch(() => {});
	}
}
