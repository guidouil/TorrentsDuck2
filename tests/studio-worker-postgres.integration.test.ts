import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFile, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { Client, type Pool } from 'pg';
import type { StudioClip, StudioEdit, StudioJob } from '../src/lib/studio';

const exec = promisify(execFile);
const mediaAvailable = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0 && spawnSync('ffprobe', ['-version'], { stdio: 'ignore' }).status === 0;

describe.skipIf(!process.env.TEST_DATABASE_URL || !mediaAvailable)('Studio worker with PostgreSQL and native FFmpeg', () => {
	const schema = `studio_worker_test_${randomUUID().replaceAll('-', '')}`;
	const owner = `worker-fixture-${randomUUID()}`;
	let admin: Client | undefined;
	let db: Pool | undefined;
	let studio: typeof import('../src/lib/server/studio');
	let workerModule: typeof import('../src/lib/server/studio-worker');
	let root = '', schemaReady = false;
	let clip: StudioClip;
	type RunningWorker = { controller: AbortController; done: Promise<unknown> };
	const workers = new Set<RunningWorker>();

	async function until<T>(read: () => Promise<T | undefined | false>, message: string, timeout = 15_000): Promise<T> {
		const deadline = Date.now() + timeout;
		do {
			const value = await read();
			if (value !== undefined && value !== false) return value;
			await new Promise((resolve) => setTimeout(resolve, 100));
		} while (Date.now() < deadline);
		throw new Error(message);
	}

	function startWorker(): RunningWorker {
		const controller = new AbortController();
		const worker = { controller, done: workerModule.runStudioWorker(controller.signal).then(() => undefined, (error: unknown) => error) };
		workers.add(worker);
		return worker;
	}

	async function settled(worker: RunningWorker) {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([worker.done, new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error('Le moteur ne s’arrête pas.')), 10_000);
			})]);
		} finally { clearTimeout(timer); }
	}

	async function stopWorker(worker: RunningWorker) {
		worker.controller.abort(new Error('Arrêt du moteur pour le test.'));
		const outcome = await settled(worker);
		workers.delete(worker);
		expect(outcome).toBeUndefined();
	}

	async function jobState(projectId: string, jobId: string, status: StudioJob['status']) {
		return until(async () => {
			const job = await studio.ownedStudioJob(owner, projectId, jobId);
			return job.status === status ? job : undefined;
		}, `La tâche ${jobId} n'a pas atteint l'état ${status}.`);
	}

	async function longExport(name: string) {
		const project = await studio.createStudioProject(owner, name);
		const edit: StudioEdit = { name, aspect: '16:9', clips: Array.from({ length: 32 }, () => ({ ...clip })), subtitles: '' };
		await studio.updateStudioProject(owner, project.id, { ...edit });
		const job = await studio.createStudioJob(owner, project.id, { kind: 'export' });
		return { project, job };
	}

	async function rendering(projectId: string, jobId: string) {
		await jobState(projectId, jobId, 'running');
		await until(async () => {
			const file = await stat(path.join(root, 'studio', jobId, 'clip-0.mp4')).catch(() => undefined);
			return file?.isFile() && file.size > 0;
		}, 'FFmpeg ne commence pas le premier extrait.');
	}

	async function expectCleanJob(jobId: string) {
		expect(await readdir(path.join(root, 'studio', jobId)).catch(() => [])).toEqual([]);
		await expect(stat(path.join(root, 'studio', jobId, 'output.mp4'))).rejects.toMatchObject({ code: 'ENOENT' });
		expect((await studio.sourceFingerprint(clip)).fingerprint).toBe(clip.fingerprint);
	}

	beforeAll(async () => {
		admin = new Client({ connectionString: process.env.TEST_DATABASE_URL });
		await admin.connect();
		await admin.query(`CREATE SCHEMA "${schema}"`);
		schemaReady = true;
		const url = new URL(process.env.TEST_DATABASE_URL!);
		url.searchParams.set('options', `-csearch_path=${schema}`);
		vi.stubEnv('DATABASE_URL', url.toString());
		root = await realpath(await mkdtemp(path.join(tmpdir(), 'duck-studio-worker-pg-')));
		for (const directory of ['downloads', 'share', 'studio']) await mkdir(path.join(root, directory));
		vi.stubEnv('DATA_ROOT', root);
		vi.stubEnv('DOWNLOADS_DIR', path.join(root, 'downloads'));
		vi.stubEnv('SHARE_DIR', path.join(root, 'share'));
		vi.stubEnv('STUDIO_DIR', path.join(root, 'studio'));
		await exec('ffmpeg', ['-v', 'error', '-threads', '1', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30', '-t', '2', '-c:v', 'libx264', '-threads', '1', '-preset', 'ultrafast', path.join(root, 'share', 'source.mp4')]);
		({ db } = await import('../src/lib/server/db'));
		expect((await db.query('SELECT current_schema() AS schema')).rows[0].schema).toBe(schema);
		await db.query(await readFile(new URL('../db/001-initial.sql', import.meta.url), 'utf8'));
		await db.query('INSERT INTO "user"(id,name,username,email,enabled,approved) VALUES($1,$1,$1,$2,true,true)', [owner, `${owner}@example.org`]);
		studio = await import('../src/lib/server/studio');
		workerModule = await import('../src/lib/server/studio-worker');
		const source = { space: 'share' as const, path: 'source.mp4' };
		clip = { ...source, fingerprint: (await studio.sourceFingerprint(source)).fingerprint, start: 0, end: 2, audio: null, x: 0.5, y: 0.5, title: '' };
	}, 30_000);

	afterEach(async () => {
		for (const worker of workers) await stopWorker(worker);
		if (!db || !schemaReady) return;
		await db.query('UPDATE "user" SET approved=true WHERE id=$1', [owner]);
		await db.query('DELETE FROM studio_projects WHERE user_id=$1', [owner]);
		await db.query('DELETE FROM audit_log WHERE user_id=$1', [owner]);
		await rm(path.join(root, 'studio'), { recursive: true, force: true });
		await mkdir(path.join(root, 'studio'));
	}, 15_000);

	afterAll(async () => {
		try {
			for (const worker of workers) await stopWorker(worker);
			await db?.end();
			if (schemaReady) await admin?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
		} finally {
			await admin?.end();
			if (root) await rm(root, { recursive: true, force: true });
			vi.unstubAllEnvs();
		}
	}, 15_000);

	it('keeps queued work across a real worker restart and refuses a second renderer', async () => {
		const { project, job } = await longExport('Interruption');
		const queued = await studio.createStudioJob(owner, project.id, { kind: 'probe', source: clip });
		const first = startWorker();
		await rendering(project.id, job.id);
		const second = startWorker();
		const refused = await settled(second);
		workers.delete(second);
		expect(refused).toBeInstanceOf(Error);
		expect((refused as Error).message).toContain('déjà actif');
		await stopWorker(first);
		expect((await studio.ownedStudioJob(owner, project.id, job.id)).status).toBe('failed');
		expect((await studio.ownedStudioJob(owner, project.id, queued.id)).status).toBe('queued');
		await expectCleanJob(job.id);
		const restarted = startWorker();
		const completed = await jobState(project.id, queued.id, 'completed');
		expect(completed.result).toMatchObject({ width: 320, height: 180, fingerprint: clip.fingerprint, audio: [] });
		expect(completed.result?.duration).toBeCloseTo(2, 1);
		await stopWorker(restarted);
	}, 60_000);

	it.each(['cancel_requested', 'approval'] as const)('stops a running render after %s changes and removes its partial files', async (change) => {
		const { project, job } = await longExport(`Arrêt ${change}`);
		const worker = startWorker();
		await rendering(project.id, job.id);
		if (change === 'cancel_requested') await studio.deleteStudioJob(owner, project.id, job.id, undefined);
		else await db!.query('UPDATE "user" SET approved=false WHERE id=$1', [owner]);
		const cancelled = await jobState(project.id, job.id, 'cancelled');
		expect(cancelled.error).toContain('Tâche annulée ou accès retiré');
		await expectCleanJob(job.id);
		await stopWorker(worker);
	}, 60_000);
});
