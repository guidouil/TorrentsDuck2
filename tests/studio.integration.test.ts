import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client, type Pool } from 'pg';
import type { StudioClip, StudioEdit, StudioJobInput } from '../src/lib/studio';

describe.skipIf(!process.env.TEST_DATABASE_URL)('Studio with PostgreSQL', () => {
	const prefix = `studio-test-${randomUUID()}`;
	const schema = `studio_test_${randomUUID().replaceAll('-', '')}`;
	const owner = `${prefix}-owner`, other = `${prefix}-other`;
	const ids = [owner, other];
	let admin: Client | undefined;
	let db: Pool | undefined;
	let studio: typeof import('../src/lib/server/studio');
	let migration = '', root = '', schemaReady = false;
	let clip: StudioClip;
	const initialEdit = (): StudioEdit => ({ name: 'Été 🦆', aspect: '16:9', clips: [{ ...clip }], subtitles: '1\n00:00:00,500 --> 00:00:02,000\nBonjour 🦆' });

	beforeAll(async () => {
		admin = new Client({ connectionString: process.env.TEST_DATABASE_URL });
		await admin.connect();
		await admin.query(`CREATE SCHEMA "${schema}"`);
		schemaReady = true;
		const url = new URL(process.env.TEST_DATABASE_URL!);
		url.searchParams.set('options', `-csearch_path=${schema}`);
		vi.stubEnv('DATABASE_URL', url.toString());
		root = await realpath(await mkdtemp(path.join(tmpdir(), 'duck-studio-sql-')));
		for (const directory of ['downloads', 'share', 'studio']) await mkdir(path.join(root, directory));
		vi.stubEnv('DATA_ROOT', root);
		vi.stubEnv('DOWNLOADS_DIR', path.join(root, 'downloads'));
		vi.stubEnv('SHARE_DIR', path.join(root, 'share'));
		vi.stubEnv('STUDIO_DIR', path.join(root, 'studio'));
		vi.stubEnv('FILE_DELIVERY', 'node');
		({ db } = await import('../src/lib/server/db'));
		expect((await db.query('SELECT current_schema() AS schema')).rows[0].schema).toBe(schema);
		migration = await readFile(new URL('../db/001-initial.sql', import.meta.url), 'utf8');
		await db.query(migration);
		for (const id of ids) await db.query('INSERT INTO "user"(id,name,username,email,enabled,approved) VALUES($1,$1,$1,$2,true,true)', [id, `${id}@example.org`]);
		studio = await import('../src/lib/server/studio');
	});

	beforeEach(async () => {
		await writeFile(path.join(root, 'downloads', 'source.mp4'), 'fictitious complete media; FFmpeg is deliberately not used here');
		const source = { space: 'downloads' as const, path: 'source.mp4' };
		clip = { ...source, fingerprint: (await studio.sourceFingerprint(source)).fingerprint, start: 10, end: 15, audio: null, x: 0.25, y: 0.5, title: 'Premier extrait' };
	});

	afterEach(async () => {
		if (!db || !schemaReady) return;
		await db.query('DELETE FROM studio_projects WHERE user_id=ANY($1::text[])', [ids]);
		await db.query('DELETE FROM audit_log WHERE user_id=ANY($1::text[])', [ids]);
		await rm(path.join(root, 'studio'), { recursive: true, force: true });
		await mkdir(path.join(root, 'studio'));
	});

	afterAll(async () => {
		try {
			await db?.end();
			if (schemaReady) await admin?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
		} finally {
			await admin?.end();
			if (root) await rm(root, { recursive: true, force: true });
			vi.unstubAllEnvs();
		}
	});

	it('creates real UUIDs and restricts project CRUD to the owner', async () => {
		const created = await studio.createStudioProject(owner, '  Nouveau projet  ');
		expect(created.id).toMatch(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
		expect(created).toMatchObject({ name: 'Nouveau projet', aspect: '16:9', clips: [], subtitles: '' });
		expect(await studio.studioProjects(owner)).toEqual([created]);
		expect(await studio.studioProjects(other)).toEqual([]);
		await expect(studio.ownedStudioProject(other, created.id)).rejects.toMatchObject({ status: 404 });
		await expect(studio.updateStudioProject(other, created.id, { ...initialEdit() })).rejects.toMatchObject({ status: 404 });
		await expect(studio.deleteStudioProject(other, created.id, true)).rejects.toMatchObject({ status: 404 });
		const updated = await studio.updateStudioProject(owner, created.id, { ...initialEdit(), aspect: '9:16' });
		expect(updated).toMatchObject({ ...initialEdit(), id: created.id, aspect: '9:16' });
		await studio.deleteStudioProject(owner, created.id, true);
		await expect(studio.ownedStudioProject(owner, created.id)).rejects.toMatchObject({ status: 404 });
		expect(await studio.studioProjects(owner)).toEqual([]);
	});

	it('replays the schema without changing existing projects or queued tasks', async () => {
		const project = await studio.createStudioProject(owner, 'Conservé');
		const job = await studio.createStudioJob(owner, project.id, { kind: 'probe', source: clip });
		expect(job.id).toMatch(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
		await db!.query(migration);
		expect(await studio.ownedStudioProject(owner, project.id)).toEqual(project);
		expect(await studio.ownedStudioJob(owner, project.id, job.id)).toMatchObject({ status: 'queued', kind: 'probe' });
		expect(await studio.studioJobs(other, project.id)).toEqual([]);
		await expect(studio.ownedStudioJob(other, project.id, job.id)).rejects.toMatchObject({ status: 404 });
		await expect(studio.deleteStudioJob(other, project.id, job.id, true)).rejects.toMatchObject({ status: 404 });
	});

	it('persists an immutable render snapshot when the project is edited later', async () => {
		const created = await studio.createStudioProject(owner, 'Montage');
		const edit = initialEdit();
		await studio.updateStudioProject(owner, created.id, { ...edit });
		const job = await studio.createStudioJob(owner, created.id, { kind: 'export' });
		edit.clips[0].title = 'Nouveau titre';
		await studio.updateStudioProject(owner, created.id, { ...edit, aspect: '9:16', subtitles: '' });
		const { rows: [stored] } = await db!.query<{ input: StudioJobInput }>('SELECT input FROM studio_jobs WHERE id=$1', [job.id]);
		expect(stored.input.project).toMatchObject({ aspect: '16:9', subtitles: initialEdit().subtitles });
		expect(stored.input.project.clips[0]).toMatchObject({ title: 'Premier extrait', fingerprint: clip.fingerprint, start: 10, end: 15 });
		expect((await studio.ownedStudioProject(owner, created.id)).clips[0].title).toBe('Nouveau titre');
		expect((await studio.ownedStudioJob(owner, created.id, job.id)).status).toBe('queued');
	});
	it('migrates the old job constraint and persists full-source dubbing without montage clips', async () => {
		const project = await studio.createStudioProject(owner, 'Film français');
		await db!.query('ALTER TABLE studio_jobs DROP CONSTRAINT studio_jobs_kind_check');
		await db!.query("ALTER TABLE studio_jobs ADD CONSTRAINT studio_jobs_kind_check CHECK (kind IN ('probe','thumbnail','preview','export'))");
		await db!.query(migration);
		const audio = await studio.createStudioJob(owner, project.id, { kind: 'dub-audio', dubbing: { url: 'https://youtu.be/abcdefghijk', offset: 0 } });
		expect(audio).toMatchObject({ kind: 'dub-audio', status: 'queued', dubbing: { url: 'https://www.youtube.com/watch?v=abcdefghijk', offset: 0 } });
		const job = await studio.createStudioJob(owner, project.id, { kind: 'dub', source: clip, dubbing: { url: 'https://youtu.be/abcdefghijk', offset: -2.5 } });
		const { rows: [stored] } = await db!.query<{ input: StudioJobInput }>('SELECT input FROM studio_jobs WHERE id=$1', [job.id]);
		expect(job).toMatchObject({ kind: 'dub', status: 'queued' });
		expect(stored.input.project.clips).toEqual([]);
		expect(stored.input.source).toEqual({ space: clip.space, path: clip.path });
		expect(stored.input.fingerprint).toBe(clip.fingerprint);
		expect(stored.input.dubbing).toEqual({ url: 'https://www.youtube.com/watch?v=abcdefghijk', offset: -2.5 });
		await db!.query(migration);
		expect((await studio.ownedStudioJob(owner, project.id, job.id)).kind).toBe('dub');
	});

	it('rejects overlong edits and replaced sources without queueing an export', async () => {
		const project = await studio.createStudioProject(owner, 'Limites');
		await expect(studio.updateStudioProject(owner, project.id, { ...initialEdit(), clips: [{ ...clip, start: 0, end: 301 }] })).rejects.toMatchObject({ status: 400 });
		expect((await studio.ownedStudioProject(owner, project.id)).clips).toEqual([]);
		await studio.updateStudioProject(owner, project.id, { ...initialEdit() });
		await writeFile(path.join(root, 'downloads', 'source.mp4'), 'source replaced after project save');
		await expect(studio.createStudioJob(owner, project.id, { kind: 'export' })).rejects.toMatchObject({ status: 409 });
		expect(await studio.studioJobs(owner, project.id)).toEqual([]);
	});

	it('enforces the active-job limit even when several tasks are submitted concurrently', async () => {
		const project = await studio.createStudioProject(owner, 'File bornée');
		const attempts = await Promise.allSettled(Array.from({ length: 12 }, () => studio.createStudioJob(owner, project.id, { kind: 'probe', source: clip })));
		expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(10);
		const rejected = attempts.filter((attempt) => attempt.status === 'rejected');
		expect(rejected).toHaveLength(2);
		for (const attempt of rejected) expect(attempt.status === 'rejected' && attempt.reason).toMatchObject({ status: 429 });
		expect((await studio.studioJobs(owner, project.id)).filter((job) => job.status === 'queued')).toHaveLength(10);
	});

	it('bounds completed job history and the number of projects per member', async () => {
		const project = await studio.createStudioProject(owner, 'Historique borné');
		await db!.query("INSERT INTO studio_jobs(project_id,user_id,kind,status,input) SELECT $1,$2,'probe','completed','{}'::jsonb FROM generate_series(1,100)", [project.id, owner]);
		await expect(studio.createStudioJob(owner, project.id, { kind: 'probe', source: clip })).rejects.toMatchObject({ status: 429 });
		await db!.query('INSERT INTO studio_projects(user_id,edit) SELECT $1,$2::jsonb FROM generate_series(1,99)', [owner, JSON.stringify({ name: 'Fixture', aspect: '16:9', clips: [], subtitles: '' })]);
		await expect(studio.createStudioProject(owner, 'Projet supplémentaire')).rejects.toMatchObject({ status: 429 });
		expect(await studio.studioProjects(other)).toEqual([]);
	});

	it('cancels queued tasks and requires confirmation before deleting a terminal job', async () => {
		const project = await studio.createStudioProject(owner, 'Annulation');
		const job = await studio.createStudioJob(owner, project.id, { kind: 'probe', source: clip });
		await studio.deleteStudioJob(owner, project.id, job.id, undefined);
		const { rows: [cancelled] } = await db!.query('SELECT status,cancel_requested FROM studio_jobs WHERE id=$1', [job.id]);
		expect(cancelled).toEqual({ status: 'cancelled', cancel_requested: true });
		await expect(studio.deleteStudioJob(owner, project.id, job.id, false)).rejects.toMatchObject({ status: 400 });
		expect((await studio.ownedStudioJob(owner, project.id, job.id)).status).toBe('cancelled');
		await studio.deleteStudioJob(owner, project.id, job.id, true);
		await expect(studio.ownedStudioJob(owner, project.id, job.id)).rejects.toMatchObject({ status: 404 });
		await expect(stat(path.join(root, 'studio', job.id))).rejects.toMatchObject({ code: 'ENOENT' });
	});

	it('requests running-job cancellation without falsely reporting worker completion', async () => {
		const project = await studio.createStudioProject(owner, 'En cours');
		const job = await studio.createStudioJob(owner, project.id, { kind: 'probe', source: clip });
		await db!.query("UPDATE studio_jobs SET status='running' WHERE id=$1", [job.id]);
		await studio.deleteStudioJob(owner, project.id, job.id, undefined);
		expect((await db!.query('SELECT status,cancel_requested FROM studio_jobs WHERE id=$1', [job.id])).rows[0]).toEqual({ status: 'running', cancel_requested: true });
	});

	it('confirms project deletion, cascades tasks and removes private outputs while preserving sources', async () => {
		const project = await studio.createStudioProject(owner, 'À supprimer');
		await studio.updateStudioProject(owner, project.id, { ...initialEdit() });
		const exportJob = await studio.createStudioJob(owner, project.id, { kind: 'export' });
		const probeJob = await studio.createStudioJob(owner, project.id, { kind: 'probe', source: clip });
		await db!.query("UPDATE studio_jobs SET status='completed' WHERE id=$1", [exportJob.id]);
		await writeFile(await studio.studioOutput(exportJob.id, 'export'), 'finished private export fixture');
		await expect(studio.deleteStudioProject(owner, project.id, false)).rejects.toMatchObject({ status: 400 });
		expect(await studio.studioJobs(owner, project.id)).toHaveLength(2);
		await studio.deleteStudioProject(owner, project.id, true);
		expect((await db!.query('SELECT id FROM studio_jobs WHERE project_id=$1', [project.id])).rows).toEqual([]);
		for (const job of [exportJob, probeJob]) await expect(stat(path.join(root, 'studio', job.id))).rejects.toMatchObject({ code: 'ENOENT' });
		expect(await readFile(path.join(root, 'downloads', 'source.mp4'), 'utf8')).toContain('fictitious complete media');
	});
});
