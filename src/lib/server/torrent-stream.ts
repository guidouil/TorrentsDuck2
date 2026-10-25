import { error } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import { query } from './db';
import { listTorrents, qbt, syncAuthors } from './qbittorrent';
import { storageStatus } from './storage';
import { requireMember } from './permissions';
import { serviceMetrics } from './metrics';

let cached: { time: number; data: Awaited<ReturnType<typeof loadSnapshot>> } | undefined;
let pending: Promise<Awaited<ReturnType<typeof loadSnapshot>>> | undefined;

async function loadSnapshot() {
	const [raw, transfer, storage, metrics] = await Promise.all([
		listTorrents(), qbt('transfer/info').then((response) => response.json()) as Promise<{ dl_info_speed: number; up_info_speed: number; dl_info_data: number; up_info_data: number; connection_status: string }>, storageStatus(), serviceMetrics()
	]);
	if (!storage.canDownload) {
		const active = raw.filter((torrent) => torrent.progress < 1 && !/^(stopped|paused)/.test(torrent.state));
		if (active.length) await qbt('torrents/stop', new URLSearchParams({ hashes: active.map((torrent) => torrent.hash).join('|') }));
	}
	await syncAuthors(raw);
	const authors = new Map((await query<{ hash: string; user_id: string | null }>('SELECT hash,user_id FROM torrent_authors')).map((row) => [row.hash, row.user_id]));
	const torrents = raw.map((torrent) => ({
		hash: torrent.hash, name: torrent.name, size: torrent.size, progress: torrent.progress,
		downloadSpeed: torrent.dlspeed, uploadSpeed: torrent.upspeed, ratio: torrent.ratio,
		peers: torrent.num_leechs + torrent.num_seeds, eta: torrent.eta, state: torrent.state,
		authorId: authors.get(torrent.hash) ?? null
	}));
	return {
		sampledAt: Date.now(), metrics,
		torrents, stats: {
			downloadSpeed: transfer.dl_info_speed, uploadSpeed: transfer.up_info_speed,
			downloaded: transfer.dl_info_data, uploaded: transfer.up_info_data,
			connection: transfer.connection_status, count: torrents.length
		}, storage: { ...storage, pausedForStorage: !storage.canDownload }
	};
}

export async function torrentSnapshot(force = false) {
	if (!force && cached && Date.now() - cached.time < 2500) return cached.data;
	if (!pending) pending = loadSnapshot().then((data) => {
		cached = { time: Date.now(), data };
		return data;
	}).finally(() => { pending = undefined; });
	return pending;
}

export function invalidateSnapshot() { cached = undefined; }

type Subscriber = { controller: ReadableStreamDefaultController<Uint8Array>; event: RequestEvent; userId: string; closed: boolean };
const subscribers = new Set<Subscriber>();
let timer: ReturnType<typeof setTimeout> | undefined;
let polling = false;
let monitoring = false;
const encoder = new TextEncoder();

function close(subscriber: Subscriber) {
	if (subscriber.closed) return;
	subscriber.closed = true;
	subscribers.delete(subscriber);
	try { subscriber.controller.close(); } catch { /* Already cancelled by the browser. */ }
	if (!monitoring && !subscribers.size && timer) { clearTimeout(timer); timer = undefined; }
}

function send(subscriber: Subscriber, type: string, value: unknown) {
	if (subscriber.closed || (subscriber.controller.desiredSize ?? 0) <= 0) return;
	try { subscriber.controller.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify(value)}\n\n`)); }
	catch { close(subscriber); }
}

async function poll() {
	if (polling || (!monitoring && !subscribers.size)) return;
	polling = true;
	try {
		await Promise.all([...subscribers].map(async (subscriber) => {
			try { await requireMember(subscriber.event); }
			catch { send(subscriber, 'unauthorized', { error: 'Session expirée.' }); close(subscriber); }
		}));
		if (!monitoring && !subscribers.size) return;
		try {
			const snapshot = await torrentSnapshot();
			for (const subscriber of subscribers) send(subscriber, 'snapshot', snapshot);
		} catch {
			for (const subscriber of subscribers) send(subscriber, 'engine-error', { error: 'Le moteur ou le stockage est indisponible.' });
		}
	} finally {
		polling = false;
		if (monitoring || subscribers.size) {
			timer = setTimeout(() => { timer = undefined; void poll(); }, subscribers.size ? 3000 : 10_000);
			timer.unref();
		}
	}
}

export function startTorrentMonitor() {
	monitoring = true;
	if (!timer && !polling) void poll();
}

export function stopTorrentMonitor() {
	monitoring = false;
	if (!subscribers.size && timer) { clearTimeout(timer); timer = undefined; }
}

export function subscribeTorrents(event: RequestEvent, userId: string) {
	if ([...subscribers].filter((subscriber) => subscriber.userId === userId).length >= 5) error(429, 'Trop de connexions en direct.');
	let subscriber: Subscriber;
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			subscriber = { controller, event, userId, closed: false };
			subscribers.add(subscriber);
			controller.enqueue(encoder.encode(': connected\nretry: 5000\n\n'));
			if (cached) send(subscriber, 'snapshot', cached.data);
			if (subscribers.size === 1 && timer) { clearTimeout(timer); timer = undefined; }
			if (!timer && !polling) void poll();
		},
		cancel() { close(subscriber); }
	});
	event.request.signal.addEventListener('abort', () => close(subscriber), { once: true });
	return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-store', 'x-accel-buffering': 'no' } });
}
