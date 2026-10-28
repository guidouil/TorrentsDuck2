import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFile, spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { sourceFingerprint, studioOutput } from '../src/lib/server/studio';
import { runStudioJob, type WorkerJob } from '../src/lib/server/studio-worker';
import type { StudioClip, StudioEdit, StudioJobKind, StudioSource } from '../src/lib/studio';

const exec = promisify(execFile);
const available = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0 && spawnSync('ffprobe', ['-version'], { stdio: 'ignore' }).status === 0;

describe.skipIf(!available)('Studio with native FFmpeg and synthetic media', () => {
	let root: string;
	const signal = () => new AbortController().signal;
	const empty: StudioEdit = { name: 'Synthetic montage', aspect: '9:16', clips: [], subtitles: '' };
	const source: StudioSource = { space: 'share', path: 'red.mp4' };
	const job = (kind: StudioJobKind, project = empty): WorkerJob => ({ id: randomUUID(), project_id: randomUUID(), user_id: 'fixture', kind, input: { project } });
	async function clip(file: string, start: number, end: number, audio: number | null): Promise<StudioClip> {
		const source: StudioSource = { space: 'share', path: file };
		return { ...source, ...(await sourceFingerprint(source)), start, end, audio, title: '', x: 0.5, y: 0.5 };
	}
	beforeAll(async () => {
		root = await mkdtemp(path.join(tmpdir(), 'duck-studio-media-'));
		for (const directory of ['share', 'downloads', 'studio']) await mkdir(path.join(root, directory));
		vi.stubEnv('SHARE_DIR', path.join(root, 'share'));
		vi.stubEnv('DOWNLOADS_DIR', path.join(root, 'downloads'));
		vi.stubEnv('STUDIO_DIR', path.join(root, 'studio'));
		await exec('ffmpeg', ['-v', 'error', '-threads', '1', '-f', 'lavfi', '-i', 'color=red:size=320x180:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '3', '-c:v', 'libx264', '-threads', '1', '-preset', 'ultrafast', '-c:a', 'aac', path.join(root, 'share/red.mp4')]);
		await exec('ffmpeg', ['-v', 'error', '-threads', '1', '-f', 'lavfi', '-i', 'color=blue:size=180x320:rate=24', '-t', '3', '-c:v', 'ffv1', '-threads', '1', path.join(root, 'share/blue.mkv')]);
	}, 30_000);
	afterAll(async () => { vi.unstubAllEnvs(); if (root) await rm(root, { recursive: true, force: true }); });

	it('probes through the inherited seekable descriptor and produces a thumbnail', async () => {
		const fingerprint = (await sourceFingerprint(source)).fingerprint;
		const probe = job('probe');
		probe.input.source = source;
		probe.input.fingerprint = fingerprint;
		const media = await runStudioJob(probe, { signal: signal() });
		expect(media).toMatchObject({ width: 320, height: 180, fingerprint, audio: [{ index: 1 }] });
		expect(media?.duration).toBeCloseTo(3, 1);
		const thumbnail = job('thumbnail');
		thumbnail.input = { ...probe.input, time: 1 };
		await runStudioJob(thumbnail, { signal: signal() });
		const bytes = await readFile(await studioOutput(thumbnail.id, 'thumbnail'));
		expect(bytes.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
	});

	it('assembles heterogeneous sources, crops portrait, burns text and retains audio then silence', async () => {
		const first = { ...await clip('red.mp4', 0.5, 1.5, 1), title: "Title %{metadata:secret} ' test" };
		const second = await clip('blue.mkv', 0.25, 1.25, null);
		const render = job('export', { ...empty, clips: [first, second], subtitles: '1\n00:00:00,000 --> 00:00:02,000\n{\\p1}Plain text caption\n' });
		const progress = vi.fn();
		await runStudioJob(render, { signal: signal(), progress });
		const output = await studioOutput(render.id, 'export');
		const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_name,width,height,sample_rate,channels', '-of', 'json', output]);
		const metadata = JSON.parse(stdout);
		expect(Number(metadata.format.duration)).toBeCloseTo(2, 0);
		expect(metadata.streams).toContainEqual(expect.objectContaining({ codec_name: 'h264', width: 1080, height: 1920 }));
		expect(metadata.streams).toContainEqual(expect.objectContaining({ codec_name: 'aac', sample_rate: '48000', channels: 2 }));
		expect(progress).toHaveBeenCalled();
		for (const region of ['crop=iw:ih/4:0:0', 'crop=iw:ih/4:0:ih*3/4']) {
			const { stdout: pixels } = await exec('ffmpeg', ['-v', 'error', '-ss', '0.5', '-i', output, '-frames:v', '1', '-vf', `${region},scale=270:120`, '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'], { encoding: 'buffer' });
			let white = 0;
			for (let index = 0; index + 2 < pixels.length; index += 3) if (Math.min(pixels[index], pixels[index + 1], pixels[index + 2]) > 200) white++;
			expect(white).toBeGreaterThan(10);
		}
		for (const [time, color] of [[0.3, 0], [1.3, 2]] as const) {
			const frame = await exec('ffmpeg', ['-v', 'error', '-ss', String(time), '-i', output, '-frames:v', '1', '-vf', 'scale=1:1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'], { encoding: 'buffer' });
			expect(frame.stdout[color]).toBeGreaterThan(frame.stdout[color === 0 ? 2 : 0] * 2);
		}
		const audio = async (time: string) => {
			const { stdout } = await exec('ffmpeg', ['-v', 'error', '-ss', time, '-i', output, '-t', '0.3', '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', 'pipe:1'], { encoding: 'buffer' });
			let peak = 0;
			for (let index = 0; index + 1 < stdout.length; index += 2) peak = Math.max(peak, Math.abs(stdout.readInt16LE(index)));
			return peak;
		};
		expect(await audio('0.3')).toBeGreaterThan(500);
		expect(await audio('1.4')).toBeLessThan(50);
	}, 60_000);

	it('produces only a short low resolution preview and refuses changed sources', async () => {
		const preview = job('preview', { ...empty, aspect: '16:9', clips: [await clip('red.mp4', 1, 1.5, 1)] });
		await runStudioJob(preview, { signal: signal() });
		const output = await studioOutput(preview.id, 'preview');
		const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=width,height', '-of', 'json', output]);
		const metadata = JSON.parse(stdout);
		expect(metadata.streams).toContainEqual({ width: 640, height: 360 });
		expect(Number(metadata.format.duration)).toBeLessThan(0.7);
		const changed = job('preview', { ...empty, clips: [await clip('red.mp4', 0, 1, 1)] });
		let modified = false;
		await expect(runStudioJob(changed, { signal: signal(), progress: () => {
			if (!modified) { modified = true; appendFileSync(path.join(root, 'share/red.mp4'), 'changed'); }
		} })).rejects.toThrow(/source.*chang|source.*modifi/i);
		await expect(readFile(await studioOutput(changed.id, 'preview'))).rejects.toMatchObject({ code: 'ENOENT' });
	}, 30_000);

	it('rejects disguised playlists instead of following their file references', async () => {
		const malicious: StudioSource = { space: 'share', path: 'playlist.mp4' };
		await writeFile(path.join(root, 'share/playlist.mp4'), "ffconcat version 1.0\nfile '/etc/passwd'\n");
		const probe = job('probe');
		probe.input.source = malicious;
		probe.input.fingerprint = (await sourceFingerprint(malicious)).fingerprint;
		await expect(runStudioJob(probe, { signal: signal() })).rejects.toThrow('non pris en charge');
	});
});
