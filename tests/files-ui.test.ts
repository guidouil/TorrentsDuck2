import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transpile } from 'typescript';
import { describe, expect, it, vi } from 'vitest';

function explorer(url: string, shallowUrl?: string, api = vi.fn().mockResolvedValue({ entries: [], total: 0 }), device = { userAgent: '', maxTouchPoints: 0 }) {
  const goto = vi.fn();
  const script = readFileSync(new URL('../src/routes/(app)/files/+page.svelte', import.meta.url), 'utf8')
    .split('<script lang="ts">')[1].split('</script>')[0].replace(/^\s*import .+;\s*$/gm, '');
  const context: Record<string, any> = {
    URL, URLSearchParams, api, goto, navigator: device,
    page: { url: new URL(url), shallow: shallowUrl ? { url: new URL(shallowUrl) } : null },
    $state: (value: unknown) => value, $derived: (value: unknown) => value, $effect: () => {}
  };
  runInNewContext(transpile(`${script}\nglobalThis.explorer = { browse, enter, switchSpace, loadFiles, fileIcon, mobileVlcUrl, makeLink, state: () => ({ space, path, query, sort, offset, entries, loading, busy, error, link, linkOpen, vlcLink }) };`), context);
  return { api, goto, ...context.explorer as {
    browse: (values: Record<string, string>, replace?: boolean) => void;
    enter: (path: string) => void;
    switchSpace: (space: string) => void;
    loadFiles: () => Promise<void>;
    fileIcon: (name: string) => string;
    mobileVlcUrl: (url: string, name: string) => string;
    makeLink: (entry: { name: string; path: string }) => Promise<void>;
    state: () => { space: string; path: string; query: string; sort: string; offset: number; entries: unknown[]; loading: boolean; busy: boolean; error: string; link: unknown; linkOpen: boolean; vlcLink: string };
  } };
}

const origin = 'https://duck.example.com/files';
const shared = `${origin}?space=share&path=Films%2F%C3%89t%C3%A9+2026&search=version+longue&sort=size&offset=50`;

describe('mobile VLC playback', () => {
  const mediaUrl = `https://duck.example.com/api/files/play/${'x'.repeat(43)}`;

  it.each([
    ['Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36', 'film.mkv', 'video'],
    ['Mozilla/5.0 (Linux; Android 15; Pixel Tablet) AppleWebKit/537.36 Chrome/130.0 Safari/537.36', 'musique.FLAC', 'audio']
  ])('targets VLC on Android with the media type, including tablets (%s)', (userAgent, name, type) => {
    const files = explorer(origin, undefined, undefined, { userAgent, maxTouchPoints: 5 });
    expect(files.mobileVlcUrl(mediaUrl, name)).toBe(`intent://duck.example.com/api/files/play/${'x'.repeat(43)}#Intent;scheme=https;package=org.videolan.vlc;type=${type}/*;end`);
    expect(files.mobileVlcUrl('http://127.0.0.1:5173/api/files/play/token', name)).toContain('intent://127.0.0.1:5173/api/files/play/token#Intent;scheme=http;');
  });

  it.each([
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1', 5],
    ['Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1', 5],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15', 5]
  ])('encodes the stream URL on iOS and iPadOS desktop mode (%s)', (userAgent, maxTouchPoints) => {
    const files = explorer(origin, undefined, undefined, { userAgent, maxTouchPoints });
    const url = `${mediaUrl}?name=${encodeURIComponent('Été & hiver.mkv')}&inline=1`;
    expect(files.mobileVlcUrl(url, 'Été & hiver.mkv')).toBe(`vlc-x-callback://x-callback-url/stream?url=${encodeURIComponent(url)}`);
  });

  it.each([
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15', 0],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36', 10],
    ['Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36', 0]
  ])('keeps the existing desktop actions without a mobile app URL (%s)', (userAgent, maxTouchPoints) => {
    expect(explorer(origin, undefined, undefined, { userAgent, maxTouchPoints }).mobileVlcUrl(mediaUrl, 'film.mp4')).toBe('');
  });

  it('prepares a revocable link before offering a separate tap to open VLC', async () => {
    const link = { id: 'link-id', url: mediaUrl, expiresAt: '2026-10-24T20:00:00.000Z' };
    const api = vi.fn().mockResolvedValue(link);
    const files = explorer(shared, undefined, api, { userAgent: 'Android', maxTouchPoints: 5 });
    await files.makeLink({ name: 'film.mkv', path: 'Films/Été 2026/film.mkv' });
    expect(api).toHaveBeenCalledWith('/api/files/share', { method: 'POST', body: JSON.stringify({ space: 'share', path: 'Films/Été 2026/film.mkv' }) });
    expect(files.state()).toMatchObject({ link, linkOpen: true, busy: false, error: '', vlcLink: files.mobileVlcUrl(mediaUrl, 'film.mkv') });
    expect(files.goto).not.toHaveBeenCalled();
  });
});

describe('file type icons', () => {
  it.each([
    ['film.mp4', 'video-file'], ['film.MKV', 'video-file'], ['film.webm', 'video-file'], ['film.mpeg', 'video-file'],
    ['musique.mp3', 'audio-file'], ['musique.FLAC', 'audio-file'], ['musique.wav', 'audio-file'], ['musique.m4a', 'audio-file'], ['musique.opus', 'audio-file'],
    ['document.pdf', 'file'], ['image.jpg', 'file'], ['archive.zip', 'file'], ['notes.mp4.txt', 'file'], ['README', 'file'], ['source.ts', 'file']
  ])('uses %s → %s', (name, expected) => {
    expect(explorer(origin).fileIcon(name)).toBe(expected);
  });
});

describe('file explorer URL navigation', () => {
  it.each([undefined, shared])('loads a bookmarked or shallow URL with all its explorer state (%s)', async (shallowUrl) => {
    const files = explorer(shallowUrl ? origin : shared, shallowUrl);
    expect(files.state()).toMatchObject({ space: 'share', path: 'Films/Été 2026', query: 'version longue', sort: 'size', offset: 50 });
    await files.loadFiles();
    const request = new URL(files.api.mock.calls[0][0], origin);
    expect(Object.fromEntries(request.searchParams)).toEqual({ space: 'share', path: 'Films/Été 2026', search: 'version longue', sort: 'size', offset: '50', limit: '50' });
  });

  it('keeps the space and sort when opening a folder, resets search and pagination, and restores them on back', () => {
    const files = explorer(shared);
    files.enter('Films/Été 2026/A & B #1');
    const [target, options] = files.goto.mock.calls[0];
    expect(target.pathname).toBe('/files');
    expect(Object.fromEntries(target.searchParams)).toEqual({ space: 'share', path: 'Films/Été 2026/A & B #1', sort: 'size' });
    expect(options).toEqual({ shallow: true, replace: false, reset: false });
    expect(explorer(origin, target.href).state()).toMatchObject({ path: 'Films/Été 2026/A & B #1', query: '', offset: 0 });
    expect(explorer(origin, shared).state()).toMatchObject({ path: 'Films/Été 2026', query: 'version longue', offset: 50 });
    expect(explorer(target.href).state()).toMatchObject({ path: 'Films/Été 2026/A & B #1', query: '', offset: 0 });
  });

  it('switches spaces at the root and preserves the chosen sort', () => {
    const files = explorer(shared);
    files.switchSpace('downloads');
    expect(Object.fromEntries(files.goto.mock.calls[0][0].searchParams)).toEqual({ space: 'downloads', sort: 'size' });
  });

  it('updates search without losing the folder or sort and replaces subsequent typing in history', () => {
    const files = explorer(shared);
    files.browse({ search: 'A&B + été', offset: '' }, true);
    const [target, options] = files.goto.mock.calls[0];
    expect(Object.fromEntries(target.searchParams)).toEqual({ space: 'share', path: 'Films/Été 2026', search: 'A&B + été', sort: 'size' });
    expect(options).toMatchObject({ replace: true });
    files.browse({ search: 'version longue', offset: '50' });
    expect(files.goto).toHaveBeenCalledTimes(1);
  });

  it.each(['-50', 'Infinity', 'NaN', '1.5', '9007199254740992'])('ignores invalid pagination offset %s', (offset) => {
    expect(explorer(`${origin}?offset=${offset}`).state().offset).toBe(0);
  });

  it('keeps the latest listing when an older request finishes later', async () => {
    let resolveFirst!: (value: unknown) => void;
    const api = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce({ entries: [{ name: 'new file' }], total: 1 });
    const files = explorer(origin, undefined, api);
    const first = files.loadFiles();
    await files.loadFiles();
    resolveFirst({ entries: [{ name: 'old file' }], total: 1 });
    await first;
    expect(files.state()).toMatchObject({ entries: [{ name: 'new file' }], loading: false, error: '' });
  });
});
