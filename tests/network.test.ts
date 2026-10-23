import { describe, it, expect } from 'vitest';
import { publicAddress, fetchTorrent, readJson } from '../src/lib/server/network';

describe('public addresses', () => {
	it.each(['127.0.0.1', '0.0.0.0', '10.1.2.3', '172.16.0.1', '192.168.1.2', '169.254.169.254', '100.64.0.1', '192.0.2.1', '198.51.100.1', '203.0.113.1', '198.18.1.1', '224.0.0.1', '255.255.255.255', '::1', 'fc00::1', 'fe80::1', '::ffff:8.8.8.8', '2001:db8::1', '2001:0db8::1', '2001::1', '2002:0808:0808::1', '3fff::1'])('denies %s', (address) => {
		expect(publicAddress(address)).toBe(false);
	});
	it.each(['8.8.8.8', '1.1.1.1', '2001:4860:4860::8888', '2606:4700:4700::1111'])('permits %s', (address) => {
		expect(publicAddress(address)).toBe(true);
	});
	it.each(['http://127.0.0.1/secret', 'http://[::1]/', 'ftp://example.com/file', 'http://admin:secret@example.com/file', 'http://example.com:8080/file'])('rejects unsafe URL %s before requesting it', async (url) => {
		await expect(fetchTorrent(url)).rejects.toMatchObject({ status: 400 });
	});
});

describe('bounded JSON', () => {
	it('rejects invalid objects and oversized bodies', async () => {
		for (const body of ['null', '[]', 'bad', JSON.stringify({ body: 'x'.repeat(20_000) })]) {
			await expect(readJson(new Request('http://localhost', { method: 'POST', body }))).rejects.toBeDefined();
		}
		expect(await readJson(new Request('http://localhost', { method: 'POST', body: '{"action":"stop"}' }))).toEqual({ action: 'stop' });
	});
});
