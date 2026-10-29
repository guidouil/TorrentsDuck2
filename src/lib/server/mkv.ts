import type { FileHandle } from 'node:fs/promises';
import { error } from '@sveltejs/kit';

type Element = { id: number; start: number; data: number; end: number; unknown: boolean };
type Patch = { offset: number; data: Buffer };
const maximumTracks = 1024 * 1024;
const invalid = (): never => error(415, 'Métadonnées MKV non prises en charge. Ouvrez ce fichier dans VLC.');

function element(buffer: Buffer, start: number, limit = buffer.length): Element {
	let position = start;
	const width = (maximum: number) => {
		const first = buffer[position];
		if (!first) return invalid();
		let length = 1;
		while (length <= maximum && !(first & (128 >> (length - 1)))) length++;
		if (length > maximum || position + length > buffer.length) return invalid();
		return length;
	};
	const idWidth = width(4);
	let id = 0;
	for (let i = 0; i < idWidth; i++) id = id * 256 + buffer[position++];
	const sizeWidth = width(8);
	let size = BigInt(buffer[position++] & (255 >> sizeWidth));
	for (let i = 1; i < sizeWidth; i++) size = size * 256n + BigInt(buffer[position++]);
	const unknown = size === (1n << BigInt(sizeWidth * 7)) - 1n;
	if (!unknown && size > BigInt(Number.MAX_SAFE_INTEGER - position)) return invalid();
	const end = unknown ? limit : position + Number(size);
	if (end > limit) return invalid();
	return { id, start, data: position, end, unknown };
}

function children(buffer: Buffer): Element[] {
	const result: Element[] = [];
	for (let position = 0; position < buffer.length;) {
		if (result.length >= 4096) return invalid();
		const child = element(buffer, position);
		if (child.unknown || (child.id === 0xbf && child.end - child.data !== 4)) return invalid();
		result.push(child);
		position = child.end;
	}
	return result;
}

async function read(handle: FileHandle, position: number, length: number) {
	const buffer = Buffer.alloc(length);
	let offset = 0;
	while (offset < length) {
		const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset);
		if (!bytesRead) return invalid();
		offset += bytesRead;
	}
	return buffer;
}

async function fileElement(handle: FileHandle, position: number, end: number) {
	const header = element(await read(handle, position, Math.min(12, end - position)), 0, end - position);
	return { ...header, start: position, data: position + header.data, end: position + header.end };
}

function unsigned(buffer: Buffer, field?: Element) {
	if (!field || field.end - field.data > 8) return invalid();
	let value = 0n;
	for (let i = field.data; i < field.end; i++) value = value * 256n + BigInt(buffer[i]);
	if (value > BigInt(Number.MAX_SAFE_INTEGER)) return invalid();
	return Number(value);
}

function text(buffer: Buffer, field?: Element) {
	return field ? buffer.toString('utf8', field.data, Math.min(field.end, field.data + 640)).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 160) : '';
}

export async function mkvAudio(handle: FileHandle, size: number, selectedId?: number) {
	if (!Number.isSafeInteger(size) || size <= 0) return invalid();
	const ebml = await fileElement(handle, 0, size);
	if (ebml.id !== 0x1a45dfa3 || ebml.unknown || ebml.end - ebml.data > 65536) return invalid();
	const header = await read(handle, ebml.data, ebml.end - ebml.data);
	if (!['matroska', 'webm'].includes(text(header, children(header).find((field) => field.id === 0x4282)))) return invalid();
	let segment = await fileElement(handle, ebml.end, size);
	for (let skipped = 0; segment.id === 0xec && skipped < 16; skipped++) {
		if (segment.unknown) return invalid();
		segment = await fileElement(handle, segment.end, size);
	}
	if (segment.id !== 0x18538067) return invalid();
	let tracks: Element | undefined;
	const segmentCrc: Element[] = [];
	for (let position = segment.data, count = 0; position < segment.end && count < 1024; count++) {
		const child = await fileElement(handle, position, segment.end);
		if (child.unknown) return invalid();
		// shortcut: Tracks must precede the first Cluster; follow SeekHead if later metadata is needed.
		if (child.id === 0x1f43b675) break;
		if (child.id === 0xbf) {
			if (child.end - child.data !== 4) return invalid();
			segmentCrc.push(child);
		}
		if (child.id === 0x1654ae6b) { tracks = child; break; }
		position = child.end;
	}
	if (!tracks || tracks.end - tracks.data > maximumTracks) return invalid();
	const buffer = await read(handle, tracks.data, tracks.end - tracks.data);
	const entries = children(buffer);
	let fieldCount = entries.length;
	const ids = new Set<number>();
	const audio: { id: number; label: string; codec: string; entry: Element; fields: Element[] }[] = [];
	for (const entry of entries.filter((entry) => entry.id === 0xae)) {
		if (ids.size >= 128) return invalid();
		const contents = buffer.subarray(entry.data, entry.end);
		const fields = children(contents);
		fieldCount += fields.length;
		if (fieldCount > 4096) return invalid();
		const field = (id: number) => fields.find((field) => field.id === id);
		const id = unsigned(contents, field(0xd7));
		if (id < 1 || ids.has(id)) return invalid();
		ids.add(id);
		if (unsigned(contents, field(0x83)) !== 2) continue;
		const codec = text(contents, field(0x86));
		if (!codec) return invalid();
		const label = [text(contents, field(0x22b59d)) || text(contents, field(0x22b59c)), text(contents, field(0x536e))].filter(Boolean).join(' · ') || `Audio ${id}`;
		audio.push({ id, label, codec, entry, fields });
	}
	const audioTracks = audio.map(({ id, label, codec }) => ({ id, label, codec }));
	const patches: Patch[] = [];
	if (selectedId === undefined) return { audioTracks, patches };
	const selected = audio.find((track) => track.id === selectedId);
	if (!selected) error(400, 'Piste audio introuvable.');
	const ordered = [selected, ...audio.filter((track) => track !== selected)];
	const rewritten = ordered.map((track) => {
		const data = Buffer.from(buffer.subarray(track.entry.start, track.entry.end));
		const contentOffset = track.entry.data - track.entry.start;
		let changed = false;
		for (const field of track.fields) {
			if (field.id !== 0x88 && !(field.id === 0xb9 && track === selected)) continue;
			if (field.data === field.end) continue;
			data.fill(0, contentOffset + field.data, contentOffset + field.end);
			data[contentOffset + field.end - 1] = track === selected ? 1 : 0;
			changed = true;
		}
		if (changed) for (const field of track.fields) if (field.id === 0xbf) data[contentOffset + field.start] = 0xec;
		return data;
	});
	let audioIndex = 0;
	// Chromium selects the first supported audio stream and ignores MKV default flags.
	const output = Buffer.concat(entries.map((entry) => {
		if (audio.some((track) => track.entry === entry)) return rewritten[audioIndex++];
		const data = Buffer.from(buffer.subarray(entry.start, entry.end));
		if (entry.id === 0xbf) data[0] = 0xec;
		return data;
	}));
	patches.push({ offset: tracks.data, data: output });
	for (const crc of segmentCrc) patches.push({ offset: crc.start, data: Buffer.from([0xec]) });
	patches.sort((left, right) => left.offset - right.offset);
	return { audioTracks, patches };
}
