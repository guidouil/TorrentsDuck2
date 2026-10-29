import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mkvAudio } from '../src/lib/server/mkv';

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

function element(id: string, data: Buffer | string | number) {
	const payload = typeof data === 'number' ? Buffer.from([data]) : Buffer.from(data);
	let width = 1;
	while (payload.length >= 2 ** (width * 7) - 1) width++;
	const size = Buffer.alloc(width);
	let value = payload.length;
	for (let i = width - 1; i >= 0; i--) { size[i] = value % 256; value = Math.floor(value / 256); }
	size[0] |= 128 >> (width - 1);
	return Buffer.concat([Buffer.from(id, 'hex'), size, payload]);
}
const crc = () => element('bf', Buffer.from([1, 2, 3, 4]));
const entry = (id: number, type: number, codec: string, language = '', title = '', enabled = 1) => element('ae', Buffer.concat([
	crc(), element('d7', id), element('73c5', id + 30), element('83', type), element('86', codec),
	...(language ? [element('22b59c', language)] : []), ...(title ? [element('536e', title)] : []),
	element('88', id === 2 ? 1 : 0), element('b9', enabled)
]));
const original = entry(2, 2, 'A_AAC', 'eng', 'Original');
const french = entry(7, 2, 'A_AAC', 'fra', 'Français', 0);
const video = entry(1, 1, 'V_MPEG4/ISO/AVC');
const header = element('1a45dfa3', element('4282', 'matroska'));
const clusters = element('1f43b675', Buffer.from('payload whose position must stay unchanged'));
const cues = element('1c53bb6b', Buffer.from('cue-track=7;position=unchanged'));

function fixture(options: { tracks?: Buffer; unknownSegment?: boolean; prefix?: Buffer; suffix?: Buffer; segmentCrc?: boolean } = {}) {
	const tracks = element('1654ae6b', options.tracks ?? Buffer.concat([crc(), video, original, french]));
	const content = Buffer.concat([...(options.segmentCrc === false ? [] : [crc()]), options.prefix ?? Buffer.alloc(0), tracks, clusters, cues, options.suffix ?? Buffer.alloc(0)]);
	return Buffer.concat([header, options.unknownSegment ? Buffer.concat([Buffer.from('1853806701ffffffffffffff', 'hex'), content]) : element('18538067', content)]);
}

async function withFile<T>(data: Buffer, work: (handle: FileHandle, file: string) => Promise<T>) {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'duck-mkv-'));
	temporary.push(directory);
	const file = path.join(directory, 'name-without-an-extension');
	await writeFile(file, data);
	const handle = await open(file, 'r');
	try { return await work(handle, file); } finally { await handle.close(); }
}

function patched(source: Buffer, patches: { offset: number; data: Buffer }[]) {
	const output = Buffer.from(source);
	for (const patch of patches) patch.data.copy(output, patch.offset);
	return output;
}

describe('MKV audio metadata and playback headers', () => {
	it.each([false, true])('lists stable track numbers and labels without rewriting (unknown Segment: %s)', async (unknownSegment) => {
		const source = fixture({ unknownSegment });
		await withFile(source, async (handle, file) => {
			await handle.read(Buffer.alloc(3), 0, 3, null);
			expect(await mkvAudio(handle, source.length)).toEqual({ audioTracks: [
				{ id: 2, label: 'eng · Original', codec: 'A_AAC' }, { id: 7, label: 'fra · Français', codec: 'A_AAC' }
			], patches: [] });
			const next = Buffer.alloc(1);
			await handle.read(next, 0, 1, null);
			expect(next[0]).toBe(source[3]);
			expect(await readFile(file)).toEqual(source);
		});
	});

	it('moves the selected audio first, updates existing flags, and preserves media bytes and seek positions', async () => {
		const source = fixture();
		await withFile(source, async (handle, file) => {
			const result = await mkvAudio(handle, source.length, 7);
			const output = patched(source, result.patches);
			expect(output.length).toBe(source.length);
			expect(output.indexOf(clusters)).toBe(source.indexOf(clusters));
			expect(output.indexOf(cues)).toBe(source.indexOf(cues));
			expect(output.indexOf(element('73c5', 37))).toBeLessThan(output.indexOf(element('73c5', 32)));
			expect(output.indexOf(video)).toBe(source.indexOf(video));
			const firstAudio = output.subarray(output.indexOf(element('73c5', 37)), output.indexOf(element('73c5', 32)));
			expect(firstAudio.includes(element('88', 1))).toBe(true);
			expect(firstAudio.includes(element('b9', 1))).toBe(true);
			expect(output.includes(crc())).toBe(true); // The unmodified video entry keeps its CRC.
			expect(output.toString('hex').split(crc().toString('hex'))).toHaveLength(2);
			expect(output.subarray(source.indexOf(clusters))).toEqual(source.subarray(source.indexOf(clusters)));
			expect(await readFile(file)).toEqual(source);
			await withFile(output, async (rewritten) => {
				expect((await mkvAudio(rewritten, output.length)).audioTracks.map((track) => track.id)).toEqual([7, 2]);
			});
		});
	});

	it('can select either order and keeps every track when entries have different lengths', async () => {
		const source = fixture({ tracks: Buffer.concat([french, element('ec', 'padding'), video, original]), segmentCrc: false });
		await withFile(source, async (handle) => {
			const output = patched(source, (await mkvAudio(handle, source.length, 2)).patches);
			expect(output.length).toBe(source.length);
			expect(output.includes(element('ec', 'padding'))).toBe(true);
			expect(output.includes(video)).toBe(true);
			await withFile(output, async (rewritten) => expect((await mkvAudio(rewritten, output.length)).audioTracks.map((track) => track.id)).toEqual([2, 7]));
		});
	});

	it('uses IETF language tags and a numbered fallback for unnamed tracks', async () => {
		const localized = element('ae', Buffer.concat([element('d7', 9), element('83', 2), element('86', 'A_OPUS'), element('22b59d', 'fr-CA'), element('22b59c', 'fra')]));
		const source = fixture({ tracks: Buffer.concat([entry(2, 2, 'A_FLAC'), localized]) });
		await withFile(source, async (handle) => expect((await mkvAudio(handle, source.length)).audioTracks).toEqual([
			{ id: 2, label: 'Audio 2', codec: 'A_FLAC' }, { id: 9, label: 'fr-CA', codec: 'A_OPUS' }
		]));
	});

	it('skips large top-level bodies using positional reads', async () => {
		const source = fixture({ prefix: element('1941a469', Buffer.alloc(2 * 1024 * 1024)) });
		await withFile(source, async (handle) => expect((await mkvAudio(handle, source.length)).audioTracks).toHaveLength(2));
	});

	it('rejects a selected track that is absent or is video', async () => {
		const source = fixture();
		await withFile(source, async (handle) => {
			for (const selected of [1, 42, -1, NaN]) await expect(mkvAudio(handle, source.length, selected)).rejects.toMatchObject({ status: 400 });
		});
	});

	it.each([
		Buffer.from('not a Matroska file'),
		fixture().subarray(0, 20),
		Buffer.concat([header, Buffer.from('1853806700', 'hex')]),
		fixture({ tracks: Buffer.from('aeff', 'hex') }),
		fixture({ tracks: Buffer.concat([original, original]) }),
		fixture({ tracks: element('ae', Buffer.concat([element('d7', 2), element('83', 2)])) }),
		fixture({ tracks: Buffer.concat([element('bf', 'bad CRC'), original]) }),
		fixture({ tracks: Buffer.concat(Array.from({ length: 4097 }, () => element('ec', Buffer.alloc(0)))) }),
		fixture({ tracks: Buffer.concat(Array.from({ length: 129 }, (_, index) => entry(index + 1, 2, 'A_AAC'))) }),
		fixture({ tracks: Buffer.from('ae850000000000', 'hex') }),
		fixture({ tracks: Buffer.alloc(1024 * 1024 + 1) }),
		Buffer.concat([header, element('18538067', clusters)]),
		fixture({ prefix: Buffer.from('1941a469ff', 'hex') })
	])('rejects malformed, missing, unknown-size or oversized metadata without scanning media', async (source) => {
		await withFile(source, async (handle) => expect(mkvAudio(handle, source.length)).rejects.toMatchObject({ status: 415 }));
	});

	it('rejects truncated underlying files even when the supplied size claims more bytes', async () => {
		const source = fixture().subarray(0, 40);
		await withFile(source, async (handle) => expect(mkvAudio(handle, 10000)).rejects.toMatchObject({ status: 415 }));
	});
});
