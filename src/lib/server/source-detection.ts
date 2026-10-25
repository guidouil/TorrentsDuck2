export type SourceResult = { name: string; size: number; seeders: number; leechers: number; publishedAt: number | null; url: string; descriptionUrl: string; source: string };
type Input = { url: string; status: number; contentType: string; body: Buffer };
type RecordValue = Record<string, unknown>;

function stripActive(markup: string) {
	const opening = /<(script|style)\b/gi;
	let cursor = 0;
	let output = '';
	for (let match; (match = opening.exec(markup));) {
		output += markup.slice(cursor, match.index);
		const closing = new RegExp('<\\/' + match[1] + '\\s*>', 'gi');
		closing.lastIndex = opening.lastIndex;
		const end = closing.exec(markup);
		if (!end) return output;
		cursor = opening.lastIndex = closing.lastIndex;
	}
	return output + markup.slice(cursor);
}

function* elements(markup: string, names: string) {
	const opening = new RegExp('<(' + names + ')\\b', 'gi');
	let examined = 0;
	for (let match; ++examined <= 2000 && (match = opening.exec(markup));) {
		const end = markup.indexOf('>', opening.lastIndex);
		if (end < 0) return;
		const closing = new RegExp('<\\/' + match[1] + '\\s*>', 'gi');
		closing.lastIndex = end + 1;
		const finish = closing.exec(markup);
		if (!finish) return;
		yield { tag: match[1], attributes: markup.slice(opening.lastIndex, end), content: markup.slice(end + 1, finish.index), index: match.index };
		opening.lastIndex = closing.lastIndex;
	}
}

const hashPattern = /^(?:[a-f0-9]{40}|[a-z2-7]{32})$/i;
const fields = {
	name: ['name', 'title', 'fileName', 'filename'],
	link: ['magnet', 'magnetUrl', 'magnet_uri', 'magnetURL', 'fileUrl', 'downloadUrl', 'download_url', 'torrent', 'torrentUrl', 'url', 'link'],
	hash: ['info_hash', 'infohash', 'infoHash', 'hash'],
	size: ['size', 'size_bytes', 'fileSize', 'length'],
	seeders: ['seeders', 'seeds', 'nbSeeders'],
	leechers: ['leechers', 'leech', 'nbLeechers'],
	date: ['publishedAt', 'pubDate', 'pub_date', 'created_unix', 'added', 'published', 'date', 'createdAt'],
	description: ['descriptionUrl', 'descrLink', 'details', 'detailsUrl', 'guid']
};

function decode(value: string) {
	return value.replaceAll('<![CDATA[', '').replaceAll(']]>', '').replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (match, code: string) => {
		if (code[0] !== '#') return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' } as Record<string, string>)[code.toLowerCase()] ?? match;
		const point = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
		return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : '';
	});
}

function text(value: unknown) {
	return typeof value === 'string' ? decode(stripActive(value.replaceAll('<![CDATA[', '').replaceAll(']]>', '')).replace(/<[^<>]*>/g, '')).replace(/\s+/g, ' ').trim().slice(0, 1000) : '';
}

function first(entry: RecordValue, names: string[]) { return names.map((name) => entry[name]).find((value) => value !== undefined && value !== null && value !== ''); }

function count(value: unknown) {
	const number = typeof value === 'string' && /^\s*\d[\d,\s]*\s*$/.test(value) ? Number(value.replace(/[,\s]/g, '')) : value;
	return typeof number === 'number' && Number.isSafeInteger(number) && number >= 0 ? number : -1;
}

function size(value: unknown) {
	if (count(value) >= 0) return count(value);
	if (typeof value !== 'string') return -1;
	const match = /^\s*(\d+(?:[.,]\d+)?)\s*([kmgt]?i?b|bytes?|octets?)\s*$/i.exec(value);
	if (!match) return -1;
	const unit = match[2].toLowerCase();
	const exponent = Math.max(0, 'bkmgt'.indexOf(unit[0]));
	return count(Math.round(Number(match[1].replace(',', '.')) * (unit.includes('i') ? 1024 : 1000) ** exponent));
}

function date(value: unknown) {
	if (typeof value === 'string' && /^\d+$/.test(value)) value = Number(value);
	if (typeof value === 'number') {
		const timestamp = value < 100_000_000_000 ? value * 1000 : value;
		return Number.isSafeInteger(timestamp) && timestamp > 0 && timestamp <= 8_640_000_000_000_000 ? timestamp : null;
	}
	if (typeof value !== 'string') return null;
	const relative = /^(\d+)\s+(minute|hour|day|week|month|year)s?(?:\s+ago)?$/i.exec(value.trim());
	if (relative) {
		const timestamp = Date.now() - Number(relative[1]) * ({ minute: 60, hour: 3600, day: 86400, week: 604800, month: 2592000, year: 31536000 } as Record<string, number>)[relative[2].toLowerCase()] * 1000;
		return Number.isSafeInteger(timestamp) && timestamp > 0 ? timestamp : null;
	}
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null;
}

function link(value: unknown, base: string, download = false) {
	if (typeof value !== 'string' || value.length > 16_384) return '';
	try {
		const url = new URL(decode(value).trim(), base);
		if (url.username || url.password) return '';
		if (url.protocol === 'magnet:') return url.searchParams.getAll('xt').some((xt) => /^urn:btih:/i.test(xt) && hashPattern.test(xt.slice(9)) || /^urn:btmh:1220[a-f0-9]{64}$/i.test(xt)) ? url.href : '';
		if (!['http:', 'https:'].includes(url.protocol)) return '';
		const cachedHash = /\/(?:torrent\/)?([a-f0-9]{40})\.torrent$/i.exec(url.pathname);
		if (/^(?:www\.)?itorrents\.(?:net|org)$/i.test(url.hostname) && cachedHash) return 'magnet:?xt=urn:btih:' + cachedHash[1].toLowerCase();
		return download || /\.torrent$/i.test(url.pathname) ? url.href : '';
	} catch { return ''; }
}

function webLink(value: unknown, base: string) {
	if (typeof value !== 'string' || value.length > 16_384) return '';
	try { const url = new URL(decode(value).trim(), base); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : ''; }
	catch { return ''; }
}

function result(entry: RecordValue, base: string): SourceResult | null {
	let url = '';
	for (const key of fields.link) {
		url = link(entry[key], base, ['fileUrl', 'downloadUrl', 'download_url', 'torrent', 'torrentUrl'].includes(key));
		if (url) break;
	}
	const hash = first(entry, fields.hash);
	if (!url && typeof hash === 'string' && hashPattern.test(hash)) url = 'magnet:?xt=urn:btih:' + hash;
	if (!url) return null;
	return {
		name: text(first(entry, fields.name)) || text(new URL(url).searchParams.get('dn')) || 'Torrent',
		size: size(first(entry, fields.size)), seeders: count(first(entry, fields.seeders)), leechers: count(first(entry, fields.leechers)),
		publishedAt: date(first(entry, fields.date)), url,
		descriptionUrl: webLink(first(entry, fields.description), base), source: new URL(base).hostname
	};
}

function attributes(markup: string) {
	const values: Record<string, string> = Object.create(null);
	for (const match of markup.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) values[match[1].toLowerCase()] = decode(match[2] ?? match[3]);
	return values;
}

function tag(markup: string, name: string) { for (const entry of elements(markup, name)) return text(entry.content); return ''; }

function jsonEntries(value: unknown, depth = 0): unknown[] | null {
	if (Array.isArray(value)) return value;
	if (!value || typeof value !== 'object' || depth > 3) return null;
	const entry = value as RecordValue;
	for (const key of ['results', 'torrents', 'items', 'data']) {
		if (entry[key] !== undefined) { const found = jsonEntries(entry[key], depth + 1); if (found) return found; }
	}
	return fields.link.some((key) => key in entry) || fields.hash.some((key) => key in entry) ? [entry] : null;
}

function feedEntries(markup: string, base: string) {
	const entries: SourceResult[] = [];
	let examined = 0;
	for (const match of elements(markup, 'item|entry')) {
		if (++examined > 2000) break;
		const item = match.content;
		const attrs: Record<string, string> = Object.create(null);
		for (const attr of item.matchAll(/<(?:[\w-]+:)?attr\b([^>]*?)\/?>/gi)) { const value = attributes(attr[1]); if (value.name) attrs[value.name.toLowerCase()] = value.value; }
		const entry: RecordValue = { name: tag(item, 'title'), size: attrs.size, seeders: attrs.seeders ?? attrs.seeds, leechers: attrs.leechers ?? attrs.leech, infohash: attrs.infohash, magnet: attrs.magneturl, pubDate: tag(item, 'pubDate') || tag(item, 'published') || tag(item, 'updated') || tag(item, 'dc:date') };
		const itemLink = tag(item, 'link') || tag(item, 'guid');
		entry.link = itemLink;
		entry.descriptionUrl = itemLink;
		if (entry.leechers === undefined && count(attrs.peers) >= 0 && count(entry.seeders) >= 0) entry.leechers = Math.max(0, count(attrs.peers) - count(entry.seeders));
		for (const enclosure of item.matchAll(/<(enclosure|link)\b([^>]*?)\/?>/gi)) {
			const value = attributes(enclosure[2]);
			if (enclosure[1].toLowerCase() === 'enclosure' || value.rel === 'enclosure') {
				const candidate = value.url ?? value.href;
				if (!entry.magnet) entry.magnet = link(candidate, base);
				if (value.type?.toLowerCase() === 'application/x-bittorrent') entry.downloadUrl = candidate;
				entry.size ??= value.length;
			} else if (value.href && !entry.descriptionUrl) { entry.descriptionUrl = value.href; entry.link = value.href; }
		}
		const parsed = result(entry, base);
		if (parsed) entries.push(parsed);
	}
	return { entries, examined };
}

// shortcut: HTML detection reads links and row metadata; add an adapter for script-generated results.
function htmlEntries(markup: string, base: string) {
	const entries: SourceResult[] = [];
	let examined = 0;
	for (const match of elements(markup, 'a')) {
		if (++examined > 2000) break;
		const attr = attributes(match.attributes);
		const url = link(attr.href, base);
		if (!url) continue;
		const before = markup.slice(Math.max(0, match.index - 4096), match.index);
		const rowStart = before.lastIndexOf('<tr');
		const after = markup.slice(match.index, match.index + 8192);
		const rowEnd = after.indexOf('</tr>');
		const row = rowStart >= 0 && rowEnd >= 0 ? before.slice(rowStart) + after.slice(0, rowEnd) : match.content.slice(0, 8192);
		const rowAttr = attributes(/^<tr\b([^>]*)>/i.exec(row)?.[1] ?? '');
		const data = { ...rowAttr, ...attr };
		function cell(name: string) { return text(new RegExp('<td\\b[^>]*(?:class|data-label)=["\'][^"\']*(?:' + name + ')[^"\']*["\'][^>]*>([\\s\\S]*?)<\\/td>', 'i').exec(row)?.[1]); }
		const parsed = result({
			magnet: url, name: data['data-name'] || attr.title || text(match.content) || tag(row, 'h[1-6]'),
			size: data['data-size'] || cell('size') || /\b\d+(?:[.,]\d+)?\s*[KMGT]i?B\b/i.exec(text(row))?.[0],
			seeders: data['data-seeders'] || cell('seed|tdseed'), leechers: data['data-leechers'] || cell('leech|tdleech'),
			pubDate: data['data-date'] || attributes(/<time\b([^>]*)>/i.exec(row)?.[1] ?? '').datetime || cell('date'),
			descriptionUrl: data['data-description-url']
		}, base);
		if (parsed) entries.push(parsed);
	}
	return entries;
}

function structure(value: unknown, depth = 0, budget = { fields: 64 }): unknown {
	if (Array.isArray(value)) return { type: 'array', length: value.length, ...(depth < 3 ? { items: value.slice(0, 2).map((entry) => structure(entry, depth + 1, budget)) } : {}) };
	if (!value || typeof value !== 'object') return { type: value === null ? 'null' : typeof value };
	const entry = value as RecordValue;
	const keys = Object.keys(entry).slice(0, Math.min(16, budget.fields));
	budget.fields -= keys.length;
	const children = depth < 3 ? Object.fromEntries(['results', 'torrents', 'items', 'data'].filter((key) => entry[key] && typeof entry[key] === 'object').map((key) => [key, structure(entry[key], depth + 1, budget)])) : {};
	return { type: 'object', fields: keys.map(safeName), ...(Object.keys(children).length ? { children } : {}) };
}

function safeName(value: string) { return /^[a-z][\w:.-]{0,39}$/i.test(value) && !/^[a-f0-9]{24,}$/i.test(value) ? value : '[redacted-field]'; }

export function detectSourceResponse(input: Input) {
	const oversized = input.body.length > 2 * 1024 * 1024;
	const markup = oversized ? '' : input.body.toString('utf8').replace(/^\uFEFF/, '').trim();
	let detected = 'unknown';
	let format: 'json' | 'rss' | 'html' | null = null;
	let reason = 'unsupported';
	let empty = false;
	let results: SourceResult[] = [];
	let shape: unknown;
	const html = stripActive(markup);
	const isHtml = /<(?:!doctype\s+html|html|body|a|form|table)\b/i.test(markup);
	const isFeed = /^(?:<\?xml[^>]*>\s*)?<(?:rss|feed|rdf:RDF)\b/i.test(markup);
	const captcha = isHtml && /(?:cf-chl-|challenge-platform|(?:class|id)\s*=\s*["'][^"']*(?:g-recaptcha|hcaptcha)|<title\b[^>]*>\s*(?:captcha|just a moment|attention required))/i.test(markup);
	if (oversized) reason = 'response-too-large';
	else if (captcha && (input.status < 200 || input.status >= 300)) reason = 'captcha';
	else if (input.status === 401 || input.status === 403) reason = 'http-auth';
	else if (input.status < 200 || input.status >= 300) reason = input.status === 429 ? 'http-rate-limit' : 'http-error';
	else if (/^[\[{]/.test(markup) || (!isFeed && !isHtml && /\bjson\b/i.test(input.contentType))) {
		detected = 'json';
		try {
			const value: unknown = JSON.parse(markup);
			shape = structure(value);
			const entries = jsonEntries(value);
			if (entries) {
				results = entries.slice(0, 2000).flatMap((entry) => entry && typeof entry === 'object' && !Array.isArray(entry) ? result(entry as RecordValue, input.url) ?? [] : []);
				empty = entries.length === 0;
				if (results.length || empty) { format = 'json'; reason = empty ? 'empty' : 'ok'; }
			}
		} catch { reason = 'invalid-json'; }
	} else if (isFeed) {
		detected = 'rss';
		const feed = feedEntries(markup, input.url);
		results = feed.entries;
		empty = !feed.examined && !/<(?:item|entry)\b/i.test(markup) && /<\/(?:rss|feed|rdf:RDF)\s*>/i.test(markup);
		if (results.length || empty) { format = 'rss'; reason = empty ? 'empty' : 'ok'; }
		else if (!/<\/(?:rss|feed|rdf:RDF)\s*>/i.test(markup)) reason = 'invalid-feed';
	} else if (isHtml) {
		detected = 'html';
		results = htmlEntries(html, input.url);
		empty = /\b(?:no (?:torrents?|results?) (?:found|available)|aucun(?:e)? r[ée]sultat)\b/i.test(text(html));
		if (results.length || empty) { format = 'html'; reason = empty ? 'empty' : 'ok'; }
	}
	if (input.status >= 200 && input.status < 300 && isHtml) {
		if (captcha && !results.length) { format = null; empty = false; reason = 'captcha'; }
		else if (!format && /<input\b[^>]*type\s*=\s*["']?password\b/i.test(html)) reason = 'login';
	}
	const unique = new Map<string | null, SourceResult>();
	for (const entry of results) {
		const key = entry.url.startsWith('magnet:') ? new URL(entry.url).searchParams.get('xt') : entry.url;
		if (!unique.has(key)) unique.set(key, entry);
	}
	results = [...unique.values()].slice(0, 2000);
	if (detected === 'unknown' && isHtml) detected = 'html';
	if (!shape && (isHtml || detected === 'rss')) {
		const tags = new Set<string>();
		const attributeNames = new Set<string>();
		let examined = 0;
		for (const match of markup.matchAll(/<([a-z][\w:-]*)\b([^<>]{0,8192})>/gi)) {
			if (++examined > 4000) break;
			if (tags.size < 40) tags.add(safeName(match[1]));
			for (const name of Object.keys(attributes(match[2]))) if (attributeNames.size < 40) attributeNames.add(safeName(name));
		}
		shape = { tags: [...tags], attributes: [...attributeNames] };
	}
	let origin = 'invalid';
	let parameters: string[] = [];
	try { const url = new URL(input.url); origin = url.origin.slice(0, 300); parameters = [...new Set(url.searchParams.keys())].slice(0, 20).map(safeName); } catch { /* No input URL is included verbatim in diagnostics. */ }
	const contentType = input.contentType.split(';')[0].trim().toLowerCase();
	const report = { version: 1, timestamp: new Date().toISOString(), origin, queryParameters: parameters, httpStatus: input.status, contentType: /^[\w.+-]+\/[\w.+-]+$/.test(contentType) && contentType.length <= 100 ? contentType : 'unknown', bytes: input.body.length, attempted: ['json', 'rss-atom-torznab', 'html-links'], detected, reason, results: results.length, empty, structure: shape ?? null };
	const pretty = JSON.stringify(report, null, 2);
	const diagnostic = pretty.length <= 8192 ? pretty : JSON.stringify(report);
	return { format, results, diagnostic, reason, empty };
}
