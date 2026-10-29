import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transpile } from 'typescript';
import { describe, expect, it, vi } from 'vitest';

type Player = {
  currentTime: number; paused: boolean; volume: number; muted: boolean; playbackRate: number;
  canPlayType: ReturnType<typeof vi.fn>; pause: ReturnType<typeof vi.fn>; play: ReturnType<typeof vi.fn>;
};

function explorer(url: string, shallowUrl?: string, api = vi.fn().mockResolvedValue({ entries: [], total: 0 }), device = { userAgent: '', maxTouchPoints: 0 }, role = 'member') {
  const goto = vi.fn();
  const script = readFileSync(new URL('../src/routes/(app)/files/+page.svelte', import.meta.url), 'utf8')
    .split('<script lang="ts">')[1].split('</script>')[0].replace(/^\s*import .+;\s*$/gm, '');
  const context: Record<string, any> = {
    URL, URLSearchParams, api, goto, navigator: device, $t: { audioResumeHelp: 'Resume playback', browserUnsupported: 'Unsupported media' },
    page: { url: new URL(url), shallow: shallowUrl ? { url: new URL(shallowUrl) } : null },
    $props: () => ({ data: { user: { role } } }),
    $state: (value: unknown) => value, $derived: (value: unknown) => value, $effect: () => {}
  };
  runInNewContext(transpile(`${script}\nglobalThis.explorer = { browse, enter, switchSpace, loadFiles, fileIcon, mobileVlcUrl, makeLink, ask, mutate, openVideo, changeAudioTrack, loadedVideo, canPlayAudio, setPlayer: (element) => { player = element; }, videoSource: () => video ? fileUrl(video, true, selectedAudio) : '', state: () => ({ space, path, query, sort, offset, entries, loading, busy, error, link, linkOpen, vlcLink, canDelete, dialogOpen, selected, video, videoOpen, audioTracks, selectedAudio, audioLoading, audioError, mobilePlayback }) };`), context);
  return { api, goto, ...context.explorer as {
    browse: (values: Record<string, string>, replace?: boolean) => void;
    enter: (path: string) => void;
    switchSpace: (space: string) => void;
    loadFiles: () => Promise<void>;
    fileIcon: (name: string) => string;
    mobileVlcUrl: (url: string, name: string) => string;
    makeLink: (entry: { name: string; path: string }) => Promise<void>;
    ask: (action: string, entry: { name: string; path: string }) => void;
    mutate: (event: { preventDefault: () => void }) => Promise<void>;
    openVideo: (entry: { name: string; path: string }) => Promise<void>;
    changeAudioTrack: (id: string) => void;
    loadedVideo: (event: { currentTarget: Player }) => void;
    canPlayAudio: (codec: string) => boolean;
    setPlayer: (element: Player) => void;
    videoSource: () => string;
    state: () => { space: string; path: string; query: string; sort: string; offset: number; entries: unknown[]; loading: boolean; busy: boolean; error: string; link: unknown; linkOpen: boolean; vlcLink: string; canDelete: boolean; dialogOpen: boolean; selected: unknown; video: unknown; videoOpen: boolean; audioTracks: unknown[]; selectedAudio: string; audioLoading: boolean; audioError: string; mobilePlayback: boolean };
  } };
}

const origin = 'https://duck.example.com/files';
const shared = `${origin}?space=share&path=Films%2F%C3%89t%C3%A9+2026&search=version+longue&sort=size&offset=50`;

describe('file deletion', () => {
  it.each([
    [origin, 'member', false],
    [origin, 'admin', true],
    [shared, 'member', true],
    [shared, 'admin', true]
  ])('offers deletion for %s as %s: %s', (url, role, expected) => {
    expect(explorer(url, undefined, undefined, undefined, role).state().canDelete).toBe(expected);
  });

  it('asks before deleting a download and sends explicit confirmation on submit', async () => {
    const files = explorer(origin, undefined, undefined, undefined, 'admin');
    const entry = { name: 'film.mkv', path: 'Films/film.mkv' };
    files.ask('delete', entry);
    expect(files.state()).toMatchObject({ dialogOpen: true, selected: entry });
    expect(files.api).not.toHaveBeenCalled();
    await files.mutate({ preventDefault() {} });
    expect(files.api).toHaveBeenCalledWith('/api/files', { method: 'POST', body: JSON.stringify({ action: 'delete', space: 'downloads', path: entry.path, name: '', confirm: true }) });
    expect(files.state()).toMatchObject({ dialogOpen: false, busy: false, error: '' });
  });
});

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

describe('web player audio selection', () => {
  const movie = { name: 'film.MKV', path: 'Films/Été & hiver.mkv' };
  const tracks = [
    { id: 2, label: 'eng · Original', codec: 'A_AAC' },
    { id: 3, label: 'fra · Français', codec: 'A_AAC' },
    { id: 4, label: 'Commentary', codec: 'A_TRUEHD' }
  ];

  function mediaPlayer(paused = false) {
    const element: Player = {
      currentTime: 123.5, paused, volume: 0.35, muted: true, playbackRate: 1.5,
      canPlayType: vi.fn((mime: string) => mime.includes('mp4a.40.2') ? 'probably' : ''),
      pause: vi.fn(), play: vi.fn()
    };
    element.pause.mockImplementation(() => { element.paused = true; });
    element.play.mockImplementation(() => { element.paused = false; return Promise.resolve(); });
    return element;
  }

  it('requests MKV tracks and includes the chosen track in the protected playback URL', async () => {
    const api = vi.fn().mockResolvedValue({ audioTracks: tracks });
    const files = explorer(shared, undefined, api);
    files.setPlayer(mediaPlayer());
    await files.openVideo(movie);
    expect(api).toHaveBeenCalledTimes(1);
    expect(Object.fromEntries(new URL(api.mock.calls[0][0], origin).searchParams)).toEqual({ space: 'share', path: movie.path });
    expect(files.state()).toMatchObject({ videoOpen: true, audioLoading: false, audioTracks: tracks, selectedAudio: '2', audioError: '' });
    expect(Object.fromEntries(new URL(files.videoSource(), origin).searchParams)).toEqual({ space: 'share', path: movie.path, inline: '1', audio: '2' });
    await files.openVideo({ name: 'film.mp4', path: 'film.mp4' });
    expect(api).toHaveBeenCalledTimes(1);
    expect(files.state()).toMatchObject({ audioTracks: [], selectedAudio: '', audioLoading: false });
    expect(new URL(files.videoSource(), origin).searchParams.has('audio')).toBe(false);
  });

  it.each([false, true])('restores position, volume and speed after switching to VF (paused: %s)', async (paused) => {
    const files = explorer(origin, undefined, vi.fn().mockResolvedValue({ audioTracks: tracks }));
    const element = mediaPlayer(paused);
    files.setPlayer(element);
    await files.openVideo(movie);
    files.changeAudioTrack('3');
    expect(element.pause).toHaveBeenCalledOnce();
    expect(new URL(files.videoSource(), origin).searchParams.get('audio')).toBe('3');
    Object.assign(element, { currentTime: 0, volume: 1, muted: false, playbackRate: 1 });
    files.loadedVideo({ currentTarget: element });
    expect(element).toMatchObject({ currentTime: 123.5, paused, volume: 0.35, muted: true, playbackRate: 1.5 });
    expect(element.play).toHaveBeenCalledTimes(paused ? 0 : 1);
  });

  it('ignores unsupported, unknown and unchanged audio choices', async () => {
    const files = explorer(origin, undefined, vi.fn().mockResolvedValue({ audioTracks: tracks }));
    const element = mediaPlayer();
    files.setPlayer(element);
    await files.openVideo(movie);
    expect(files.canPlayAudio('A_TRUEHD')).toBe(false);
    expect(files.canPlayAudio('A_AC3')).toBe(false);
    for (const id of ['2', '4', '99']) files.changeAudioTrack(id);
    expect(element.pause).not.toHaveBeenCalled();
    expect(files.state().selectedAudio).toBe('2');
  });

  it('keeps the original playback state when another change arrives before metadata loads', async () => {
    const files = explorer(origin, undefined, vi.fn().mockResolvedValue({ audioTracks: tracks }));
    const element = mediaPlayer();
    files.setPlayer(element);
    await files.openVideo(movie);
    files.changeAudioTrack('3');
    files.changeAudioTrack('2');
    expect(files.state().selectedAudio).toBe('3');
    expect(element.pause).toHaveBeenCalledOnce();
    files.loadedVideo({ currentTarget: element });
    expect(element.play).toHaveBeenCalledOnce();
    files.changeAudioTrack('2');
    expect(files.state().selectedAudio).toBe('2');
  });

  it('shows a manual resume hint when the browser blocks restarting playback', async () => {
    const files = explorer(origin, undefined, vi.fn().mockResolvedValue({ audioTracks: tracks }));
    const element = mediaPlayer();
    files.setPlayer(element);
    await files.openVideo(movie);
    files.changeAudioTrack('3');
    element.play.mockRejectedValue(new Error('autoplay blocked'));
    files.loadedVideo({ currentTarget: element });
    await Promise.resolve();
    expect(files.state().audioError).toBe('Resume playback');
  });

  it('keeps the latest file when an older metadata request finishes later', async () => {
    let resolveFirst!: (value: unknown) => void;
    const latestTracks = [{ id: 8, label: 'Latest', codec: 'A_AAC' }];
    const api = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce({ audioTracks: latestTracks });
    const files = explorer(origin, undefined, api);
    files.setPlayer(mediaPlayer());
    const first = files.openVideo(movie);
    expect(files.state().audioLoading).toBe(true);
    const latest = { name: 'latest.mkv', path: 'latest.mkv' };
    await files.openVideo(latest);
    resolveFirst({ audioTracks: tracks });
    await first;
    expect(files.state()).toMatchObject({ video: latest, audioTracks: latestTracks, selectedAudio: '8', audioLoading: false });
  });

  it('retains original playback if metadata cannot be read', async () => {
    const files = explorer(origin, undefined, vi.fn().mockRejectedValue(new Error('Open in VLC')));
    files.setPlayer(mediaPlayer());
    await files.openVideo(movie);
    expect(files.state()).toMatchObject({ videoOpen: true, audioTracks: [], selectedAudio: '', audioLoading: false, audioError: 'Open in VLC' });
    expect(new URL(files.videoSource(), origin).searchParams.has('audio')).toBe(false);
  });

  it.each([
    ['Android', 5, true], ['iPhone', 5, true], ['Macintosh', 5, true], ['Windows NT 10.0', 10, false], ['Macintosh', 0, false]
  ])('recommends VLC for mobile and tablet playback (%s, %s touches)', async (userAgent, maxTouchPoints, expected) => {
    const files = explorer(origin, undefined, undefined, { userAgent, maxTouchPoints });
    await files.openVideo({ name: 'film.mp4', path: 'film.mp4' });
    expect(files.state().mobilePlayback).toBe(expected);
  });
});

describe('file explorer URL navigation', () => {
  it.each([
    [origin, 'modifiedAt'],
    [`${origin}?space=share`, 'modifiedAt'],
    [`${origin}?path=Films`, 'name'],
    [`${origin}?space=share&path=Films%2FÉté`, 'name']
  ])('uses the default sort for %s when no sort is selected', async (url, sort) => {
    const files = explorer(url);
    expect(files.state().sort).toBe(sort);
    await files.loadFiles();
    expect(new URL(files.api.mock.calls[0][0], origin).searchParams.get('sort')).toBe(sort);
  });

  it.each([undefined, shared])('loads a bookmarked or shallow URL with all its explorer state (%s)', async (shallowUrl) => {
    const files = explorer(shallowUrl ? origin : shared, shallowUrl);
    expect(files.state()).toMatchObject({ space: 'share', path: 'Films/Été 2026', query: 'version longue', sort: 'size', offset: 50 });
    await files.loadFiles();
    const request = new URL(files.api.mock.calls[0][0], origin);
    expect(Object.fromEntries(request.searchParams)).toEqual({ space: 'share', path: 'Films/Été 2026', search: 'version longue', sort: 'size', offset: '50', limit: '50' });
  });

  it.each([
    ['Films/Été 2026/A & B #1', 'name'],
    ['Films', 'name'],
    ['', 'modifiedAt']
  ])('resets sort, search and pagination when entering %s and restores them on back', (path, sort) => {
    const files = explorer(shared);
    files.enter(path);
    const [target, options] = files.goto.mock.calls[0];
    expect(target.pathname).toBe('/files');
    expect(Object.fromEntries(target.searchParams)).toEqual({ space: 'share', ...(path ? { path } : {}) });
    expect(options).toEqual({ shallow: true, replace: false, reset: false });
    expect(explorer(origin, target.href).state()).toMatchObject({ path, sort, query: '', offset: 0 });
    expect(explorer(origin, shared).state()).toMatchObject({ path: 'Films/Été 2026', sort: 'size', query: 'version longue', offset: 50 });
    expect(explorer(target.href).state()).toMatchObject({ path, sort, query: '', offset: 0 });
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
