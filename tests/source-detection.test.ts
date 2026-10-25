import { describe, expect, it, vi, afterEach } from 'vitest';
import { detectSourceResponse } from '../src/lib/server/source-detection';

const hash = 'a'.repeat(40);
const magnet = 'magnet:?xt=urn:btih:' + hash;
function detect(body: string | unknown, contentType = 'application/json', status = 200, url = 'https://index.example/search?q=private-term&apikey=private-api-key') {
	return detectSourceResponse({ url, status, contentType, body: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)) });
}

afterEach(() => vi.useRealTimers());

describe('URL source response detection', () => {
	it('detects JSON envelopes and normalizes APiBay and Torrents CSV metadata', () => {
		const parsed = detect({ data: { torrents: [{ name: 'Ubuntu', info_hash: hash, size: '1024', seeders: '25', leechers: '3', added: '1700000000' }] } }, 'text/plain');
		expect(parsed).toMatchObject({ format: 'json', reason: 'ok', empty: false, results: [{ name: 'Ubuntu', url: magnet, size: 1024, seeders: 25, leechers: 3, publishedAt: 1700000000000 }] });
	});

	it('supports JSON magnets, torrent endpoints, human sizes and unknown statistics', () => {
		const parsed = detect({ results: [
			{ title: 'Tears of Steel', magnetUrl: magnet, size: '1.5 GiB', publishedAt: '2026-01-02T12:00:00Z' },
			{ title: 'Torrent endpoint', downloadUrl: '/api/download/42', seeds: '1,024', size_bytes: 2048 }
		] });
		expect(parsed.results[0]).toMatchObject({ size: 1.5 * 1024 ** 3, seeders: -1, leechers: -1, publishedAt: Date.parse('2026-01-02T12:00:00Z') });
		expect(parsed.results[1]).toMatchObject({ url: 'https://index.example/api/download/42', seeders: 1024, size: 2048 });
	});

	it('rejects unsafe and ordinary HTML page links from JSON records', () => {
		const parsed = detect([{ name: 'One', url: 'javascript:alert(1)' }, { name: 'Two', fileUrl: 'https://user:private@example.org/file.torrent' }, { name: 'Three', link: '/details/42' }]);
		expect(parsed).toMatchObject({ format: null, reason: 'unsupported', results: [], empty: false });
	});

	it('recognizes empty known JSON lists without accepting arbitrary empty objects', () => {
		expect(detect({ results: [] })).toMatchObject({ format: 'json', empty: true, reason: 'empty' });
		expect(detect({ token: 'private-token', status: 'ok' })).toMatchObject({ format: null, empty: false });
		expect(detect('{}')).toMatchObject({ format: null, empty: false });
		expect(detect('{ "results": ')).toMatchObject({ format: null, reason: 'invalid-json' });
	});

	it('detects Torznab RSS enclosures, attributes, entities and RFC dates', () => {
		const parsed = detect(`<?xml version="1.0"?><rss xmlns:torznab="http://torznab.com/schemas/2015/feed"><channel><item>
			<title>Ubuntu &amp; friends</title><link>https://index.example/details/42</link><pubDate>Fri, 02 Jan 2026 12:00:00 GMT</pubDate>
			<enclosure url="/download/42" type="application/x-bittorrent" length="1024" />
			<torznab:attr name="seeders" value="5"/><torznab:attr name="peers" value="8"/>
		</item></channel></rss>`, 'application/xml');
		expect(parsed).toMatchObject({ format: 'rss', results: [{ name: 'Ubuntu & friends', size: 1024, seeders: 5, leechers: 3, url: 'https://index.example/download/42', descriptionUrl: 'https://index.example/details/42', publishedAt: Date.parse('2026-01-02T12:00:00Z') }] });
	});

	it('detects Atom enclosures and RSS info hashes', () => {
		const atom = detect(`<feed><entry><title>Atom fixture</title><link rel="alternate" href="/view/42"/><link rel="enclosure" type="application/x-bittorrent" href="/file.torrent"/><updated>2026-01-02T12:00:00Z</updated></entry></feed>`, 'application/atom+xml');
		expect(atom).toMatchObject({ format: 'rss', results: [{ name: 'Atom fixture', url: 'https://index.example/file.torrent', descriptionUrl: 'https://index.example/view/42' }] });
		const rss = detect(`<rss><channel><item><title><![CDATA[Hash fixture]]></title><torznab:attr name="infohash" value="${hash}"/></item></channel></rss>`, 'application/rss+xml');
		expect(rss.results[0]).toMatchObject({ name: 'Hash fixture', url: magnet });
	});

	it('sniffs RSS and HTML bodies even when the server incorrectly declares JSON', () => {
		const rss = detect(`<rss><channel><item><title>RSS fixture</title><torznab:attr name="infohash" value="${hash}"/></item></channel></rss>`, 'application/json');
		expect(rss).toMatchObject({ format: 'rss', reason: 'ok', results: [{ name: 'RSS fixture', url: magnet }] });
		const html = detect(`<html><body><a href="${magnet}">HTML fixture</a></body></html>`, 'application/json');
		expect(html).toMatchObject({ format: 'html', reason: 'ok', results: [{ name: 'HTML fixture', url: magnet }] });
		expect(detect({ results: [{ name: 'JSON fixture', magnet }] }, 'text/html')).toMatchObject({ format: 'json', reason: 'ok' });
	});

	it('recognizes empty feeds and rejects truncated feeds', () => {
		expect(detect('<rss><channel></channel></rss>', 'application/rss+xml')).toMatchObject({ format: 'rss', empty: true });
		expect(detect('<feed></feed>', 'application/atom+xml')).toMatchObject({ format: 'rss', empty: true });
		expect(detect('<rss><channel><item><title>Missing end', 'application/rss+xml')).toMatchObject({ format: null, reason: 'invalid-feed', empty: false });
	});

	it('detects HTML magnets and cache hashes with row metadata, and removes duplicates', () => {
		vi.useFakeTimers(); vi.setSystemTime(new Date('2026-01-03T00:00:00Z'));
		const parsed = detect(`<html><body><table><tr data-size="1 MiB" data-seeders="10" data-leechers="2" data-date="2 days ago"><td><a href="${magnet}">Ubuntu</a></td></tr>
		<tr><td><a href="https://itorrents.net/torrent/${'b'.repeat(40)}.torrent">Another torrent</a></td><td class="tdseed">25</td><td class="tdleech">3</td><td class="size">2 GB</td><td><time datetime="2026-01-02T00:00:00Z"></time></td></tr>
		<a href="${magnet}&amp;tr=udp%3A%2F%2Ftracker.example">Ubuntu duplicate</a></table></body></html>`, 'text/html');
		expect(parsed.format).toBe('html');
		expect(parsed.results).toHaveLength(2);
		expect(parsed.results.find((entry) => entry.url === magnet)?.size).toBe(1024 ** 2);
		expect(parsed.results.find((entry) => entry.url.endsWith('b'.repeat(40)))).toMatchObject({ seeders: 25, leechers: 3, size: 2_000_000_000, publishedAt: Date.parse('2026-01-02T00:00:00Z') });
	});

	it('distinguishes authentication, rate limits, captcha and unsupported script pages', () => {
		expect(detect('<html><form><input type="password"></form></html>', 'text/html')).toMatchObject({ format: null, reason: 'login' });
		expect(detect('<html>Cloudflare <div class="cf-chl-container"></div></html>', 'text/html', 403)).toMatchObject({ format: null, reason: 'captcha' });
		expect(detect({ error: 'private error details' }, 'application/json', 401)).toMatchObject({ format: null, reason: 'http-auth' });
		expect(detect('', 'text/plain', 429)).toMatchObject({ format: null, reason: 'http-rate-limit' });
		expect(detect(`<html><script>const fake='<a href="${magnet}">Fake</a>';</script></html>`, 'text/html')).toMatchObject({ format: null, results: [], empty: false });
		expect(detect(`<html><form><input type="password"></form><a href="${magnet}">Captcha documentary</a></html>`, 'text/html')).toMatchObject({ format: 'html', reason: 'ok', results: [{ name: 'Captcha documentary' }] });
	});

	it('emits a bounded diagnostic without credentials, query values or body values', () => {
		const parsed = detect({ items: [{ token: 'never-copy-token', password: 'never-copy-password', unknownField: 'never-copy-body-value' }] }, 'application/json; private=never-copy-content-type', 200, 'https://login-user:never-copy-url-password@index.example/private-path-secret?q=never-copy-query&apikey=never-copy-api-key');
		const report = JSON.parse(parsed.diagnostic);
		expect(report).toMatchObject({ version: 1, origin: 'https://index.example', queryParameters: ['q', 'apikey'], detected: 'json', reason: 'unsupported' });
		for (const forbidden of ['never-copy', 'login-user', 'private-path-secret']) expect(parsed.diagnostic).not.toContain(forbidden);
		expect(parsed.diagnostic.length).toBeLessThanOrEqual(8192);
	});

	it('describes nested unknown envelope fields without copying their values', () => {
		const parsed = detect({ data: { items: [{ new_title: 'never-copy-title', source_token: 'never-copy-token', alternate_url: 'never-copy-url' }] } });
		const report = JSON.parse(parsed.diagnostic);
		expect(report.structure.children.data.children.items.items[0]).toMatchObject({ type: 'object', fields: ['new_title', 'source_token', 'alternate_url'] });
		expect(parsed.diagnostic).not.toContain('never-copy');
	});

	it('keeps deeply nested large diagnostics valid JSON and below eight thousand characters', () => {
		const record = Object.fromEntries(Array.from({ length: 80 }, (_, index) => ['field' + String(index).padStart(3, '0') + 'x'.repeat(30), 'never-copy-value']));
		const parsed = detect({ data: { items: [record, record], results: [record, record] }, results: { data: [record, record], torrents: [record, record] }, items: [record, record] });
		expect(() => JSON.parse(parsed.diagnostic)).not.toThrow();
		expect(parsed.diagnostic.length).toBeLessThanOrEqual(8192);
		expect(parsed.diagnostic).not.toContain('never-copy-value');
	});

	it('limits large source lists to two thousand candidates', () => {
		const parsed = detect(Array.from({ length: 2100 }, (_, index) => ({ title: String(index), downloadUrl: '/file/' + index + '.torrent' })));
		expect(parsed.results).toHaveLength(2000);
	});

	it('rejects oversized documents and safely ignores malformed active content', () => {
		expect(detect('x'.repeat(2 * 1024 * 1024 + 1), 'text/plain')).toMatchObject({ format: null, reason: 'response-too-large' });
		expect(detect('<html><script>' + `<a href="${magnet}">Fake</a>`.repeat(3000), 'text/html')).toMatchObject({ format: null, results: [] });
		expect(detect('<rss><channel>' + '<item>'.repeat(5000) + '</channel></rss>', 'application/rss+xml')).toMatchObject({ format: null, results: [] });
	});
});
