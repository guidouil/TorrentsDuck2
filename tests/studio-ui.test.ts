import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { compile } from 'svelte/compiler';
// @ts-expect-error Compiled SSR output uses this runtime, which has no public declarations.
import * as server from 'svelte/internal/server';
import { render } from 'svelte/server';
import { get } from 'svelte/store';
import { transpile } from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { language, t } from '../src/lib/i18n';
import { STUDIO_MAX_SECONDS, parseStudioSrt, studioDuration, type StudioClip, type StudioMedia, type StudioProject } from '../src/lib/studio';

const source = readFileSync(new URL('../src/routes/(app)/studio/[id]/+page.svelte', import.meta.url), 'utf8');
const media: StudioMedia = { space: 'downloads', path: 'Films/Source.mp4', fingerprint: 'fixture', width: 1920, height: 1080, duration: 600, audio: [{ index: 1, label: 'French' }] };
const clip: StudioClip = { space: media.space, path: media.path, fingerprint: media.fingerprint, start: 0, end: 20, x: 0.5, y: 0.5, audio: 1, title: '' };
const project: StudioProject = { id: 'project', name: 'Private montage', aspect: '16:9', clips: [clip], subtitles: '', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };

function editor(api = vi.fn()) {
  const derived = Object.assign((value: unknown) => value, { by: (fn: () => unknown) => fn() });
  const context: Record<string, any> = {
    api, STUDIO_MAX_SECONDS, parseStudioSrt, studioDuration, URLSearchParams,
    onMount: vi.fn(), beforeNavigate: vi.fn(), goto: vi.fn(), page: { params: { id: 'project' } },
    $state: (value: unknown) => value, $derived: derived, $t: get(t)
  };
  const script = source.split('<script lang="ts">')[1].split('</script>')[0].replace(/^\s*import .+;\s*$/gm, '')
    .replace('const selected = $derived(project?.clips[selectedIndex]);', "Object.defineProperty(globalThis, 'selected', { get: () => project?.clips[selectedIndex] });")
    .replace('const total = $derived(project ? studioDuration(project.clips) : 0);', "Object.defineProperty(globalThis, 'total', { get: () => project ? studioDuration(project.clips) : 0 });");
  runInNewContext(transpile(`${script}\nglobalThis.editor = {
    refresh, addMedia, moveClip, removeClip, createJob, importSrt, cancelJob, isVideo, ask, confirm,
    fileUrl, timecode, seek, playClip, updatePlayback, finishSeeking, selectClip, setBoundary,
    setup: (value, tasks = []) => { project = value; jobs = tasks; baseline = JSON.stringify(edit(value)); },
    playback: (element, length = 600) => { video = element; sourceDuration = length; playhead = element.currentTime; },
    dubbing: (url, offset) => { dubbingUrl = url; dubbingOffset = offset; },
    state: () => ({ project, jobs, selectedIndex, error, busy, previewingClip, selectedJob, confirmation, sharedName })
  };`), context);
  context.editor.setup(structuredClone(project));
  return { api, ...context.editor };
}

describe('studio editing', () => {
  it('retains unsaved edits while polling render progress', async () => {
    const remote = { ...project, name: 'Saved version' };
    const task = { id: 'render', status: 'running', progress: 45 };
    const ui = editor(vi.fn().mockResolvedValue({ project: remote, jobs: [task] }));
    const local = structuredClone(project); local.name = 'Unsaved version'; local.clips[0].start = 4;
    ui.setup(local);
    await ui.refresh();
    expect(ui.state().project).toBe(local);
    expect(ui.state().project.clips[0].start).toBe(4);
    expect(ui.state().jobs).toEqual([task]);
  });

  it('limits a new excerpt to the remaining time and refuses another at 300 seconds', () => {
    const ui = editor();
    ui.setup({ ...structuredClone(project), clips: [{ ...clip, end: 295 }] });
    ui.addMedia(media);
    expect(ui.state().project.clips[1]).toMatchObject({ end: 5, audio: 1, x: 0.5, y: 0.5, fingerprint: 'fixture' });
    ui.addMedia(media);
    expect(ui.state().project.clips).toHaveLength(2);
    expect(ui.state().error).toBe(get(t).studio.limitError);
  });

  it('reorders clips without changing their trims, and removal only edits the project', () => {
    const ui = editor();
    const first = { ...clip, path: 'one.mp4', start: 5 }, second = { ...clip, path: 'two.mp4', start: 8 };
    ui.setup({ ...structuredClone(project), clips: [first, second] });
    ui.moveClip(1, -1);
    expect(ui.state().project.clips).toEqual([second, first]);
    expect(ui.state().selectedIndex).toBe(0);
    ui.removeClip(0);
    expect(ui.state().project.clips).toEqual([first]);
    expect(ui.api).not.toHaveBeenCalled();
  });

  it('saves the project before requesting an export and cancels with a JSON body', async () => {
    const api = vi.fn().mockResolvedValueOnce({ project }).mockResolvedValueOnce({ job: { id: 'render', kind: 'export', status: 'queued' } });
    const ui = editor(api);
    await ui.createJob('export');
    expect(api.mock.calls[0][0]).toBe('/api/studio/project');
    expect(api.mock.calls[0][1].method).toBe('PATCH');
    expect(api.mock.calls[1]).toEqual(['/api/studio/project/jobs', { method: 'POST', body: JSON.stringify({ kind: 'export' }) }]);
    expect(ui.state().selectedJob).toBe('render');
    api.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ project, jobs: [] });
    await ui.cancelJob({ id: 'render' });
    expect(api).toHaveBeenNthCalledWith(3, '/api/studio/project/jobs/render', { method: 'DELETE', body: '{}' });
  });

  it('adds a completed source analysis only once across repeated polls', async () => {
    const job = { id: 'probe', kind: 'probe', status: 'queued', result: null };
    const completed = { ...job, status: 'completed', result: media };
    const api = vi.fn().mockResolvedValueOnce({ job }).mockResolvedValue({ project, jobs: [completed] });
    const ui = editor(api);
    await ui.createJob('probe', { space: media.space, path: media.path });
    await ui.refresh(); await ui.refresh();
    expect(ui.state().project.clips).toHaveLength(2);
    expect(ui.state().project.clips[1].end).toBe(30);
  });

  it('rejects an overlong montage before sending any save or export request', async () => {
    const ui = editor();
    ui.setup({ ...structuredClone(project), clips: [{ ...clip, end: 301 }] });
    await ui.createJob('export');
    expect(ui.api).not.toHaveBeenCalled();
    expect(ui.state().error).toBe(get(t).studio.limitError);
  });

  it('imports SRT against the final montage duration and preserves prior content on failure', async () => {
    const ui = editor();
    const valid = '1\n00:00:01,000 --> 00:00:02,000\nCaption';
    const input = { files: [{ size: valid.length, text: async () => valid }], value: 'selected' };
    await ui.importSrt({ currentTarget: input });
    expect(ui.state().project.subtitles).toBe(valid);
    const rejectedInput = { files: [{ size: 50000, text: async () => valid }], value: 'selected' };
    await ui.importSrt({ currentTarget: rejectedInput });
    expect(rejectedInput.value).toBe('');
    expect(ui.state().project.subtitles).toBe(valid);
    expect(ui.state().error).toBe(get(t).studio.srtInvalid);
  });
});

describe('studio French soundtrack', () => {
  it('queues the whole source and an offset without saving montage edits or applying clip bounds', async () => {
    const job = { id: 'dub', kind: 'dub', status: 'queued' };
    const ui = editor(vi.fn().mockResolvedValue({ job }));
    ui.setup({ ...structuredClone(project), clips: [{ ...clip, start: 150, end: 550 }] });
    ui.dubbing(' https://youtu.be/abcdefghijk ', -2.25);
    await ui.createJob('dub', { space: clip.space, path: clip.path });
    expect(ui.api).toHaveBeenCalledExactlyOnceWith('/api/studio/project/jobs', {
      method: 'POST', body: JSON.stringify({ kind: 'dub', source: { space: clip.space, path: clip.path }, dubbing: { url: 'https://youtu.be/abcdefghijk', offset: -2.25 } })
    });
    expect(ui.state().jobs).toEqual([job]);
    expect(ui.state().selectedJob).toBe('');
    expect(ui.state().project.clips[0]).toMatchObject({ start: 150, end: 550 });
  });

  it.each([NaN, 601, -601])('refuses invalid offsets before requesting work (%s)', async (offset) => {
    const ui = editor();
    ui.dubbing('https://youtu.be/abcdefghijk', offset);
    await ui.createJob('dub', { space: clip.space, path: clip.path });
    expect(ui.api).not.toHaveBeenCalled();
    expect(ui.state().error).toBe(get(t).studio.dubInvalid);
    expect(ui.state().busy).toBe(false);
  });

  it('uses an MKV name and waits for confirmation before publishing the French copy', async () => {
    const ui = editor(vi.fn().mockResolvedValue({ path: 'Private montage-fr.mkv' }));
    ui.ask('publish', { id: 'dub', kind: 'dub', status: 'completed' });
    expect(ui.api).not.toHaveBeenCalled();
    expect(ui.state()).toMatchObject({ confirmation: 'publish', sharedName: 'Private montage-fr.mkv' });
    await ui.confirm();
    expect(ui.api).toHaveBeenCalledExactlyOnceWith('/api/studio/project/jobs/dub/publish', {
      method: 'POST', body: JSON.stringify({ name: 'Private montage-fr.mkv', confirm: true })
    });
  });
});

describe('studio source playback', () => {
  const player = (currentTime = 0) => ({ currentTime, seeking: false, pause: vi.fn(), play: vi.fn().mockResolvedValue(undefined) });

  it('keeps the source URL stable when trim, crop, title or audio changes', () => {
    const ui = editor();
    const original = ui.fileUrl(clip);
    const changed = ui.fileUrl({ ...clip, start: 150, end: 180, x: 0.2, y: 0.8, title: 'New title', audio: null });
    expect(changed).toBe(original);
    expect([...new URL(changed, 'https://example.test').searchParams.keys()]).toEqual(['space', 'path', 'inline']);
  });

  it('allows playback beyond the selected excerpt and stops only an explicit clip preview', () => {
    const ui = editor(), video = player(150);
    ui.playback(video);
    ui.updatePlayback();
    expect(video.currentTime).toBe(150);
    expect(video.pause).not.toHaveBeenCalled();
    ui.playClip();
    expect(video.currentTime).toBe(clip.start);
    expect(video.play).toHaveBeenCalledOnce();
    video.currentTime = clip.end;
    ui.updatePlayback();
    expect(video.pause).toHaveBeenCalledOnce();
    expect(ui.state().previewingClip).toBe(false);
    video.pause.mockClear(); video.currentTime = 150;
    ui.updatePlayback();
    expect(video.currentTime).toBe(150);
    expect(video.pause).not.toHaveBeenCalled();
  });

  it('lets native seeking escape a clip preview without pausing or rewinding', () => {
    const ui = editor(), video = player();
    ui.playback(video); ui.playClip();
    video.currentTime = 150; video.seeking = true;
    ui.updatePlayback();
    expect(video.pause).not.toHaveBeenCalled();
    ui.finishSeeking(); video.seeking = false;
    ui.updatePlayback();
    expect(ui.state().previewingClip).toBe(false);
    expect(video.currentTime).toBe(150);
    expect(video.pause).not.toHaveBeenCalled();
  });

  it('bounds source navigation to its full duration and cancels clip preview', () => {
    const ui = editor(), video = player();
    ui.playback(video); ui.playClip();
    ui.seek(150);
    expect(video.currentTime).toBe(150);
    expect(ui.state().previewingClip).toBe(false);
    ui.seek(-10); expect(video.currentTime).toBe(0);
    ui.seek(700); expect(video.currentTime).toBe(600);
    ui.seek(NaN); expect(video.currentTime).toBe(600);
    ui.playback(video, NaN); ui.seek(20);
    expect(video.currentTime).toBe(600);
  });

  it('marks a passage beyond the initial excerpt while keeping valid bounds', () => {
    const ui = editor();
    ui.playback(player(150)); ui.setBoundary('start');
    expect(ui.state().project.clips[0]).toMatchObject({ start: 150, end: 170 });
    ui.playback(player(180)); ui.setBoundary('end');
    expect(ui.state().project.clips[0]).toMatchObject({ start: 150, end: 180 });
    ui.playback(player(590)); ui.setBoundary('start');
    expect(ui.state().project.clips[0]).toMatchObject({ start: 590, end: 600 });
    ui.playback(player(5)); ui.setBoundary('end');
    expect(ui.state().project.clips[0]).toMatchObject({ start: 0, end: 5 });
  });

  it('marks the actual video position immediately after a seek, before timeupdate', () => {
    const ui = editor(), video = player();
    ui.playback(video);
    video.currentTime = 150;
    ui.setBoundary('start');
    expect(ui.state().project.clips[0]).toMatchObject({ start: 150, end: 170 });
    ui.seek(180); ui.setBoundary('end');
    expect(ui.state().project.clips[0]).toMatchObject({ start: 150, end: 180 });
  });

  it('clears clip preview when selecting another excerpt', () => {
    const ui = editor(), video = player();
    ui.setup({ ...structuredClone(project), clips: [clip, { ...clip, start: 50, end: 60 }] });
    ui.playback(video); ui.playClip(); ui.selectClip(1);
    expect(ui.state().previewingClip).toBe(false);
    expect(video.currentTime).toBe(50);
  });

  it('formats a precise source position for short and long videos', () => {
    const ui = editor();
    expect([0, 65, 5400, NaN].map(ui.timecode)).toEqual(['0:00', '1:05', '90:00', '—']);
  });
});

describe('studio caption safety and translations', () => {
  it.each(['preview-title', 'preview-subtitle'])('renders %s as escaped text', (className) => {
    const markup = source.match(new RegExp(`<span class="${className}">[\\s\\S]*?<\\/span>`))![0];
    const compiled = compile(`<script>let { selected, subtitle } = $props();</script>${markup}`, { generate: 'server', filename: 'Caption.svelte' }).js.code
      .replace(/^import .+;\s*$/gm, '').replace('export default function', 'function');
    const Caption = runInNewContext(`${compiled}\nCaption;`, { $: server });
    const malicious = '<img src=x onerror=alert(1)>';
    const { body } = render(Caption, { props: { selected: { title: malicious }, subtitle: malicious } });
    expect(body).toContain('&lt;img');
    expect(body).not.toContain('<img');
  });

  it('provides matching French and English studio labels', () => {
    language.set('fr'); const french = get(t).studio;
    language.set('en'); const english = get(t).studio;
    language.set('fr');
    expect(Object.keys(french)).toEqual(Object.keys(english));
    expect(Object.values(french).every(Boolean)).toBe(true);
    expect(Object.values(english).every(Boolean)).toBe(true);
  });
});
