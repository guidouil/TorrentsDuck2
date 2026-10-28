import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { chmod, open, readdir, rename, rm, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import type { PoolClient } from 'pg';
import { isHttpError } from '@sveltejs/kit';
import { db } from './db.js';
import { requireStudioStorage, sourceFingerprint, studioFingerprint, studioJobDirectory, studioOutput, studioRoot, validateStudioEdit } from './studio.js';
import { parseStudioSrt, studioDuration } from '../studio.js';
import type { StudioClip, StudioCue, StudioEdit, StudioJobInput, StudioJobKind, StudioMedia, StudioSource } from '../studio.js';

const formats = 'mov,matroska,webm,avi,flv,mpeg,mpegts,ogg,asf';
const workerLock = 782413;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const baseArgs = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '1', '-filter_threads', '1', '-filter_complex_threads', '1'];
const inputArgs = ['-protocol_whitelist', 'fd', '-format_whitelist', formats, '-max_streams', '64', '-probesize', '5000000', '-analyzeduration', '5000000', '-fd', '3', '-i', 'fd:'];

export type WorkerJob = { id: string; user_id: string; project_id: string; kind: StudioJobKind; input: StudioJobInput };
type WorkContext = { signal: AbortSignal; progress?: (percent: number) => void };
type ProbedMedia = StudioMedia & { videoIndex: number };

class Cancelled extends Error {}

export function studioJobAllowed(row?: { cancel_requested: boolean; enabled: boolean; approved: boolean }) {
	return !!row && !row.cancel_requested && row.enabled && row.approved;
}

export async function runStudioProcess(command: string, args: string[], options: WorkContext & { fd?: number; capture?: boolean; timeout?: number; cwd?: string }): Promise<string> {
	options.signal.throwIfAborted();
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			stdio: ['ignore', 'pipe', 'pipe', options.fd ?? 'ignore'],
			detached: process.platform !== 'win32',
			env: { PATH: process.env.PATH, LANG: 'C.UTF-8', HOME: '/tmp' }
		});
		let output = '', pending = '', failure: Error | undefined, killTimer: ReturnType<typeof setTimeout> | undefined;
		const terminate = (reason: unknown) => {
			if (failure) return;
			failure = reason instanceof Error ? reason : new Error('Traitement interrompu.');
			const kill = (signal: NodeJS.Signals) => {
				try {
					if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
					else child.kill(signal);
				} catch { /* The child may already have exited. */ }
			};
			kill('SIGTERM');
			killTimer = setTimeout(() => kill('SIGKILL'), 3000);
		};
		const abort = () => terminate(options.signal.reason);
		const timeout = setTimeout(() => terminate(new Error('Délai de traitement dépassé.')), options.timeout ?? 3_600_000);
		options.signal.addEventListener('abort', abort, { once: true });
		child.stdout?.setEncoding('utf8');
		child.stdout?.on('data', (chunk: string) => {
			if (failure) return;
			if (options.capture) {
				output += chunk;
				if (Buffer.byteLength(output) > 524288) terminate(new Error('Métadonnées trop volumineuses.'));
			} else {
				pending += chunk;
				const lines = pending.split('\n');
				pending = lines.pop()?.slice(-1024) ?? '';
				for (const line of lines) {
					const match = /^out_time_us=(\d+)$/.exec(line);
					if (match) options.progress?.(Number(match[1]) / 1_000_000);
				}
			}
		});
		// Consume diagnostics without exposing paths, metadata or unbounded output in logs.
		child.stderr?.resume();
		child.on('error', () => { failure ??= new Error(`${command === 'ffprobe' ? 'FFprobe' : 'FFmpeg'} indisponible.`); });
		child.on('close', (code) => {
			clearTimeout(timeout);
			clearTimeout(killTimer);
			options.signal.removeEventListener('abort', abort);
			if (failure) reject(failure);
			else if (code !== 0) reject(new Error('Média non pris en charge ou traitement vidéo impossible.'));
			else resolve(output);
		});
		if (options.signal.aborted) abort();
	});
}

async function withSource<T>(source: StudioSource, expected: string, work: (handle: FileHandle) => Promise<T>): Promise<T> {
	const before = await sourceFingerprint(source);
	if (before.fingerprint !== expected) throw new Error('La source a été modifiée. Analysez-la à nouveau.');
	const handle = await open(before.absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const initial = await handle.stat();
		if (!initial.isFile() || studioFingerprint(initial) !== expected) throw new Error('La source a été remplacée.');
		const result = await work(handle);
		if (studioFingerprint(await handle.stat()) !== expected || (await sourceFingerprint(source)).fingerprint !== expected) {
			throw new Error('La source a changé pendant le traitement.');
		}
		return result;
	} finally { await handle.close(); }
}

export function studioMetadata(source: StudioSource, fingerprint: string, data: unknown): ProbedMedia {
	const probe = data as { streams?: { index: number; codec_type: string; width?: number; height?: number; duration?: string; disposition?: { attached_pic?: number }; tags?: Record<string, string>; side_data_list?: { rotation?: number }[] }[]; format?: { duration?: string } };
	if (!probe || !Array.isArray(probe.streams)) throw new Error('Métadonnées vidéo invalides.');
	const video = probe.streams.find((stream) => stream.codec_type === 'video' && !stream.disposition?.attached_pic);
	const duration = Number(probe.format?.duration ?? video?.duration);
	if (!video || !Number.isInteger(video.index) || !Number.isFinite(duration) || duration <= 0 || !video.width || !video.height || video.width < 2 || video.height < 2 || video.width > 8192 || video.height > 8192) {
		throw new Error('Vidéo absente, dimensions ou durée non prises en charge.');
	}
	const rotation = Number(video.side_data_list?.find((side) => side.rotation !== undefined)?.rotation ?? video.tags?.rotate ?? 0);
	const rotated = Math.abs(rotation % 180) === 90;
	return {
		...source, fingerprint, duration, width: rotated ? video.height : video.width, height: rotated ? video.width : video.height,
		videoIndex: video.index,
		audio: probe.streams.filter((stream) => stream.codec_type === 'audio' && Number.isInteger(stream.index)).map((stream) => ({
			index: stream.index, label: [stream.tags?.language, stream.tags?.title].filter(Boolean).join(' · ').slice(0, 160) || `Audio ${stream.index}`
		}))
	};
}

async function inspectSource(source: StudioSource, fingerprint: string, context: WorkContext): Promise<ProbedMedia> {
	return withSource(source, fingerprint, async (handle) => {
		const output = await runStudioProcess('ffprobe', [
			'-v', 'error', '-threads', '1', ...inputArgs,
			'-show_entries', 'format=duration:stream=index,codec_type,width,height,duration:stream_tags=language,title,rotate:stream_side_data=rotation:stream_disposition=attached_pic',
			'-of', 'json'
		], { ...context, fd: handle.fd, capture: true, timeout: 30_000 });
		return studioMetadata(source, fingerprint, JSON.parse(output));
	});
}

export function studioDimensions(aspect: StudioEdit['aspect'], preview: boolean) {
	const horizontal = preview ? [640, 360] : [1920, 1080];
	return aspect === '16:9' ? horizontal : [horizontal[1], horizontal[0]];
}

export function validateStudioOutput(data: unknown, width: number, height: number, duration: number) {
	const probe = data as { format?: { duration?: string }; streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number; sample_rate?: string; channels?: number }[] };
	const actualDuration = Number(probe?.format?.duration);
	const video = probe?.streams?.find((stream) => stream.codec_type === 'video');
	const audio = probe?.streams?.find((stream) => stream.codec_type === 'audio');
	if (!Number.isFinite(actualDuration) || actualDuration <= 0 || Math.abs(actualDuration - duration) > 0.15 || video?.codec_name !== 'h264' || video.width !== width || video.height !== height || audio?.codec_name !== 'aac' || audio.sample_rate !== '48000' || audio.channels !== 2) {
		throw new Error('Rendu incomplet ou format de sortie invalide.');
	}
}

export function studioVideoFilter(clip: StudioClip, width: number, height: number, titleFile?: string, subtitlesFile?: string) {
	const aspect = width / height;
	const filters = [
		`crop=w='trunc(min(iw,ih*${aspect}/sar)/2)*2':h='trunc(min(ih,iw*sar/${aspect})/2)*2':x='(iw-ow)*${clip.x}':y='(ih-oh)*${clip.y}'`,
		`scale=${width}:${height}`, 'setsar=1', 'fps=30', 'setpts=PTS-STARTPTS', 'format=yuv420p'
	];
	if (titleFile) filters.push(`drawtext=font='DejaVu Sans':textfile=${titleFile}:expansion=none:fontcolor=white:fontsize=${Math.round(height * 0.055)}:box=1:boxcolor=black@0.6:boxborderw=8:x=(w-text_w)/2:y=h*0.08`);
	if (subtitlesFile) filters.push(`ass=filename=${subtitlesFile}`);
	return filters.join(',');
}

function assTime(seconds: number) {
	const centiseconds = Math.max(0, Math.round(seconds * 100));
	return `${Math.floor(centiseconds / 360000)}:${String(Math.floor(centiseconds / 6000) % 60).padStart(2, '0')}:${String(Math.floor(centiseconds / 100) % 60).padStart(2, '0')}.${String(centiseconds % 100).padStart(2, '0')}`;
}

export function studioAss(cues: StudioCue[], width: number, height: number, start = 0, duration = 300) {
	const text = (value: string) => value.replace(/\\/g, '＼').replace(/{/g, '｛').replace(/}/g, '｝').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').replace(/\n/g, '\\N');
	const events = cues.filter((cue) => cue.end > start && cue.start < start + duration).map((cue) =>
		`Dialogue: 0,${assTime(Math.max(0, cue.start - start))},${assTime(Math.min(duration, cue.end - start))},Default,,0,0,0,,${text(cue.text)}`
	);
	return `[Script Info]\nScriptType: v4.00+\nPlayResX: ${width}\nPlayResY: ${height}\nWrapStyle: 0\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,DejaVu Sans,${Math.round(height * 0.045)},&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,1,2,${Math.round(width * 0.06)},${Math.round(width * 0.06)},${Math.round(height * 0.08)},1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${events.join('\n')}\n`;
}

async function cleanDirectory(directory: string, keep?: string) {
	for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
		if (entry.name !== keep) await rm(path.join(directory, entry.name), { recursive: true, force: true });
	}
}

export async function runStudioJob(job: WorkerJob, context: WorkContext): Promise<StudioMedia | null> {
	const directory = await studioJobDirectory(job.id);
	await cleanDirectory(directory);
	await requireStudioStorage();
	if (job.kind === 'probe' || job.kind === 'thumbnail') {
		if (!job.input.source || !job.input.fingerprint) throw new Error('Source requise.');
		const media = await inspectSource(job.input.source, job.input.fingerprint, context);
		if (job.kind === 'probe') {
			const { videoIndex: _, ...publicMedia } = media;
			return publicMedia;
		}
		const output = await studioOutput(job.id, job.kind);
		const time = job.input.time ?? 0;
		if (!Number.isFinite(time) || time < 0 || time >= media.duration) throw new Error('Position de vignette invalide.');
		const partial = path.join(directory, 'thumbnail.partial.jpg');
		await withSource(job.input.source, job.input.fingerprint, (handle) => runStudioProcess('ffmpeg', [
			...baseArgs, '-ss', String(time), ...inputArgs, '-map', `0:${media.videoIndex}`, '-frames:v', '1',
			'-vf', 'scale=480:480:force_original_aspect_ratio=decrease:force_divisible_by=2', '-q:v', '3', '-f', 'image2', partial
		], { ...context, fd: handle.fd, timeout: 60_000 }));
		context.signal.throwIfAborted();
		await rename(partial, output);
		await chmod(output, 0o644);
		return null;
	}
	const output = await studioOutput(job.id, job.kind);
	const project = validateStudioEdit(job.input.project as unknown as Record<string, unknown>);
	const duration = studioDuration(project.clips);
	if (!project.clips.length || duration <= 0) throw new Error('Montage vide.');
	const cues = parseStudioSrt(project.subtitles, duration);
	const [width, height] = studioDimensions(project.aspect, job.kind === 'preview');
	const sources = new Map<string, { clip: StudioClip; media: ProbedMedia }>();
	const key = (clip: StudioClip) => `${clip.space}:${clip.path}`;
	let elapsed = 0;
	const files: string[] = [];
	for (const [index, clip] of project.clips.entries()) {
		context.signal.throwIfAborted();
		await requireStudioStorage();
		let source = sources.get(key(clip));
		if (!source) {
			source = { clip, media: await inspectSource(clip, clip.fingerprint, context) };
			sources.set(key(clip), source);
		}
		if (source.clip.fingerprint !== clip.fingerprint || clip.end > source.media.duration + 0.05 || (clip.audio !== null && !source.media.audio.some((audio) => audio.index === clip.audio))) {
			throw new Error('Découpe, piste audio ou version de source invalide.');
		}
		const clipDuration = clip.end - clip.start;
		const segment = `clip-${index}.mp4`, titleFile = clip.title ? `title-${index}.txt` : undefined;
		const subtitlesFile = cues.length ? `captions-${index}.ass` : undefined;
		if (titleFile) await writeFile(path.join(directory, titleFile), clip.title, { flag: 'wx', mode: 0o600 });
		if (subtitlesFile) await writeFile(path.join(directory, subtitlesFile), studioAss(cues, width, height, elapsed, clipDuration), { flag: 'wx', mode: 0o600 });
		// Generated filenames are the only paths allowed in filter expressions.
		const videoFilter = studioVideoFilter(clip, width, height, titleFile, subtitlesFile);
		await withSource(clip, clip.fingerprint, (handle) => runStudioProcess('ffmpeg', [
			...baseArgs, '-ss', String(clip.start), ...inputArgs,
			...(clip.audio === null ? ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo'] : []),
			'-map', `0:${source!.media.videoIndex}`, '-map', clip.audio === null ? '1:a:0' : `0:${clip.audio}`,
			'-vf', videoFilter, '-af', `aresample=48000:async=1:first_pts=0,apad,atrim=duration=${clipDuration},asetpts=PTS-STARTPTS`,
			'-t', String(clipDuration), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', job.kind === 'preview' ? '26' : '20',
			'-threads', '1', '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2', '-video_track_timescale', '90000',
			'-map_metadata', '-1', '-map_chapters', '-1', '-movflags', '+faststart', '-progress', 'pipe:1', '-f', 'mp4', path.join(directory, segment)
		], { ...context, fd: handle.fd, cwd: directory, progress: (seconds) => context.progress?.(Math.min(95, (elapsed + Math.min(clipDuration, seconds)) / duration * 95)) }));
		files.push(`file '${segment}'\nduration ${clipDuration}`);
		elapsed += clipDuration;
	}
	const list = path.join(directory, 'clips.ffconcat');
	await writeFile(list, `ffconcat version 1.0\n${files.join('\n')}\n`, { flag: 'wx', mode: 0o600 });
	const partial = path.join(directory, 'render.partial.mp4');
	await runStudioProcess('ffmpeg', [
		...baseArgs, '-protocol_whitelist', 'file', '-format_whitelist', 'concat,mov', '-f', 'concat', '-safe', '1', '-i', list,
		'-map', '0:v:0', '-map', '0:a:0', '-c', 'copy', '-t', String(duration), '-map_metadata', '-1', '-map_chapters', '-1',
		'-movflags', '+faststart', '-f', 'mp4', partial
	], context);
	const rendered = await open(partial, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		if ((await rendered.stat()).size === 0) throw new Error('Rendu vide.');
		const metadata = await runStudioProcess('ffprobe', [
			'-v', 'error', '-threads', '1', ...inputArgs,
			'-show_entries', 'format=duration:stream=codec_type,codec_name,width,height,sample_rate,channels', '-of', 'json'
		], { ...context, fd: rendered.fd, capture: true, timeout: 30_000 });
		validateStudioOutput(JSON.parse(metadata), width, height, duration);
	} finally { await rendered.close(); }
	for (const { clip } of sources.values()) {
		if ((await sourceFingerprint(clip)).fingerprint !== clip.fingerprint) throw new Error('La source a changé pendant le rendu.');
	}
	context.signal.throwIfAborted();
	await requireStudioStorage();
	await rename(partial, output);
	await chmod(output, 0o644);
	await cleanDirectory(directory, path.basename(output));
	return null;
}

async function cleanupOrphans(client: PoolClient) {
	const entries = await readdir(studioRoot(), { withFileTypes: true }).catch(() => []);
	const names = entries.filter((entry) => entry.isDirectory() && uuid.test(entry.name)).map((entry) => entry.name);
	if (!names.length) return;
	const existing = await client.query<{ id: string }>('SELECT id FROM studio_jobs WHERE id=ANY($1::text[])', [names]);
	const present = new Set(existing.rows.map((row) => row.id));
	for (const name of names) if (!present.has(name)) await rm(path.join(studioRoot(), name), { recursive: true, force: true });
}

async function processJob(client: PoolClient, job: WorkerJob, signal: AbortSignal) {
	const controller = new AbortController();
	const abort = () => controller.abort(signal.reason);
	signal.addEventListener('abort', abort, { once: true });
	if (signal.aborted) abort();
	const timeout = setTimeout(() => controller.abort(new Error('Délai de traitement dépassé.')), 3_600_000);
	let progress = 0, checking = false;
	const check = async () => {
		if (checking || controller.signal.aborted) return;
		checking = true;
		try {
			const { rows: [row] } = await client.query('SELECT j.cancel_requested,u.enabled,u.approved FROM studio_jobs j JOIN "user" u ON u.id=j.user_id WHERE j.id=$1 AND j.status=\'running\'', [job.id]);
			if (!studioJobAllowed(row)) throw new Cancelled('Tâche annulée ou accès retiré.');
			await requireStudioStorage();
			await client.query('UPDATE studio_jobs SET progress=$2,updated_at=now() WHERE id=$1 AND status=\'running\'', [job.id, Math.round(progress)]);
		} catch (error) { controller.abort(error); }
		finally { checking = false; }
	};
	const monitor = setInterval(() => { void check(); }, 1000);
	try {
		await check();
		controller.signal.throwIfAborted();
		const result = await runStudioJob(job, { signal: controller.signal, progress: (value) => { progress = value; } });
		await check();
		controller.signal.throwIfAborted();
		const completed = await client.query('UPDATE studio_jobs SET status=\'completed\',progress=100,result=$2,updated_at=now() WHERE id=$1 AND status=\'running\' AND cancel_requested=false AND EXISTS (SELECT 1 FROM "user" u WHERE u.id=studio_jobs.user_id AND u.enabled=true AND u.approved=true) RETURNING id', [job.id, result]);
		if (!completed.rowCount) throw new Cancelled('Tâche annulée ou accès retiré.');
	} catch (error) {
		const reason = controller.signal.aborted ? controller.signal.reason : error;
		const message = isHttpError(reason) ? reason.body.message : reason instanceof Error ? reason.message : 'Traitement vidéo impossible.';
		await cleanDirectory(await studioJobDirectory(job.id));
		await client.query('UPDATE studio_jobs SET status=$2,error=$3,updated_at=now() WHERE id=$1 AND status=\'running\'', [job.id, reason instanceof Cancelled ? 'cancelled' : 'failed', message.slice(0, 200)]);
	} finally {
		clearInterval(monitor);
		clearTimeout(timeout);
		signal.removeEventListener('abort', abort);
	}
}

export async function runStudioWorker(signal: AbortSignal) {
	const client = await db.connect();
	const connection = new AbortController();
	const disconnected = () => connection.abort(new Error('Connexion du moteur interrompue.'));
	client.on('error', disconnected);
	const stop = AbortSignal.any([signal, connection.signal]);
	let locked = false;
	try {
		const { rows: [lock] } = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [workerLock]);
		if (!lock.locked) throw new Error('Un moteur Studio est déjà actif.');
		locked = true;
		const interrupted = await client.query<{ id: string }>('UPDATE studio_jobs SET status=\'failed\',error=\'Rendu interrompu. Vous pouvez le relancer.\',updated_at=now() WHERE status=\'running\' RETURNING id');
		for (const job of interrupted.rows) await cleanDirectory(await studioJobDirectory(job.id));
		await cleanupOrphans(client);
		let cleanedAt = Date.now();
		while (!stop.aborted) {
			await client.query('UPDATE studio_jobs SET status=\'cancelled\',error=\'Tâche annulée ou accès retiré.\',updated_at=now() WHERE status=\'queued\' AND (cancel_requested=true OR NOT EXISTS (SELECT 1 FROM "user" u WHERE u.id=studio_jobs.user_id AND u.enabled=true AND u.approved=true))');
			const { rows: [job] } = await client.query<WorkerJob>('UPDATE studio_jobs SET status=\'running\',progress=0,error=NULL,updated_at=now() WHERE id=(SELECT id FROM studio_jobs WHERE status=\'queued\' ORDER BY created_at,id LIMIT 1) RETURNING id,user_id,project_id,kind,input');
			if (job) {
				await processJob(client, job, stop);
				await cleanupOrphans(client);
			} else {
				if (Date.now() - cleanedAt >= 60_000) { await cleanupOrphans(client); cleanedAt = Date.now(); }
				await new Promise<void>((resolve) => {
					const done = () => { clearTimeout(timer); stop.removeEventListener('abort', done); resolve(); };
					const timer = setTimeout(done, 1000);
					stop.addEventListener('abort', done, { once: true });
					if (stop.aborted) done();
				});
			}
		}
		if (connection.signal.aborted) throw connection.signal.reason;
	} finally {
		client.removeListener('error', disconnected);
		if (locked && !connection.signal.aborted) await client.query('SELECT pg_advisory_unlock($1)', [workerLock]).catch(() => {});
		client.release(connection.signal.aborted);
	}
}
