import { execFile, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { mkvAudio } from '../src/lib/server/mkv';

const exec = promisify(execFile);
const available = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');

describe.skipIf(!available)('MKV audio selection with native FFmpeg', () => {
	it('demuxes the chosen French audio first, including after seeking, while preserving video and source bytes', async () => {
		const root = await mkdtemp(path.join(tmpdir(), 'duck-mkv-media-'));
		try {
			const source = path.join(root, 'original.mkv'), selected = path.join(root, 'selected.mkv');
			await exec('ffmpeg', [
				'-v', 'error', '-threads', '1', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=12',
				'-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
				'-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000',
				'-t', '2', '-map', '0:v:0', '-map', '1:a:0', '-map', '2:a:0',
				'-c:v', 'libx264', '-threads', '1', '-preset', 'ultrafast', '-c:a', 'aac',
				'-metadata:s:a:0', 'language=eng', '-metadata:s:a:0', 'title=Original',
				'-metadata:s:a:1', 'language=fra', '-metadata:s:a:1', 'title=Français',
				'-disposition:a:0', 'default', '-disposition:a:1', '0', source
			]);
			const initial = await readFile(source);
			const handle = await open(source, 'r');
			try {
				const { audioTracks } = await mkvAudio(handle, initial.length);
				expect(audioTracks.map((track) => track.label)).toEqual(['eng · Original', 'fra · Français']);
				const { patches } = await mkvAudio(handle, initial.length, audioTracks[1].id);
				const output = Buffer.from(initial);
				for (const patch of patches) patch.data.copy(output, patch.offset);
				await writeFile(selected, output);
			} finally { await handle.close(); }
			const decode = async (file: string, audio: number, start: string) => (await exec('ffmpeg', [
				'-v', 'error', '-ss', start, '-i', file, '-map', `0:a:${audio}`, '-t', '0.5',
				'-ac', '1', '-ar', '8000', '-f', 's16le', 'pipe:1'
			], { encoding: 'buffer' })).stdout;
			for (const start of ['0', '1']) {
				const french = await decode(source, 1, start);
				expect(french.length).toBeGreaterThan(7000);
				expect(hash(await decode(selected, 0, start))).toBe(hash(french));
				expect(hash(await decode(source, 0, start))).not.toBe(hash(french));
			}
			const videoPackets = async (file: string) => (await exec('ffmpeg', [
				'-v', 'error', '-i', file, '-map', '0:v:0', '-c', 'copy', '-f', 'framehash', '-hash', 'sha256', 'pipe:1'
			])).stdout;
			expect(await videoPackets(selected)).toBe(await videoPackets(source));
			expect((await readFile(selected)).length).toBe(initial.length);
			expect(hash(await readFile(source))).toBe(hash(initial));
		} finally { await rm(root, { recursive: true, force: true }); }
	});
});
