import { createServer } from 'node:http';
import { connect, type Socket } from 'node:net';
import { publicDestination } from './network.js';

export const STUDIO_AUDIO_MAX_BYTES = 1024 * 1024 * 1024;

export async function youtubeDestination(authority: string, signal: AbortSignal) {
	if (!/^(?:[a-z0-9-]+\.)*(?:youtube\.com|googlevideo\.com|ytimg\.com):443$/i.test(authority) && authority !== 'youtubei.googleapis.com:443') {
		throw new Error('Destination YouTube interdite.');
	}
	return publicDestination(`https://${authority}`, signal);
}

// Every HTTPS connection, including redirects, resolves and pins a public YouTube address.
export async function withYoutubeProxy<T>(signal: AbortSignal, work: (proxy: string, signal: AbortSignal) => Promise<T>, maximum = STUDIO_AUDIO_MAX_BYTES): Promise<T> {
	signal.throwIfAborted();
	const sockets = new Set<Socket>();
	const controller = new AbortController();
	const stop = AbortSignal.any([signal, controller.signal]);
	let received = 0;
	const close = () => { for (const socket of sockets) socket.destroy(); };
	const server = createServer((_request, response) => { response.writeHead(403); response.end(); });
	server.maxConnections = 8;
	server.on('connection', (socket) => {
		sockets.add(socket);
		socket.on('error', () => {});
		socket.on('close', () => sockets.delete(socket));
		socket.setTimeout(30_000, () => socket.destroy());
	});
	server.on('connect', (request, client, head) => {
		void (async () => {
			const { pinned } = await youtubeDestination(request.url ?? '', stop);
			stop.throwIfAborted();
			if (client.destroyed) return;
			const remote = connect({ host: pinned.address, family: pinned.family, port: 443 });
			sockets.add(remote);
			remote.on('close', () => { sockets.delete(remote); client.destroy(); });
			client.on('close', () => remote.destroy());
			remote.on('error', () => client.destroy());
			remote.setTimeout(30_000, () => remote.destroy());
			remote.on('data', (chunk: Buffer) => {
				received += chunk.length;
				if (received > maximum) controller.abort(new Error('Bande son YouTube trop volumineuse (1 Gio maximum).'));
			});
			remote.on('connect', () => {
				client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
				if (head.length) remote.write(head);
				client.pipe(remote).pipe(client);
			});
		})().catch(() => { client.destroy(); controller.abort(new Error('Destination YouTube inaccessible ou interdite.')); });
	});
	stop.addEventListener('abort', close, { once: true });
	try {
		await new Promise<void>((resolve, reject) => {
			server.once('error', reject);
			server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
		});
		stop.throwIfAborted();
		const address = server.address();
		if (!address || typeof address === 'string') throw new Error('Proxy YouTube indisponible.');
		const result = await work(`http://127.0.0.1:${address.port}`, stop);
		stop.throwIfAborted();
		return result;
	} catch (cause) {
		stop.throwIfAborted();
		throw cause;
	} finally {
		stop.removeEventListener('abort', close);
		close();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}
