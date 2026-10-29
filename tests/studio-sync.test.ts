import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transpile } from 'typescript';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../src/lib/StudioDubbingPlayer.svelte', import.meta.url), 'utf8');
function media(currentTime = 0, duration = 100) {
  const element = {
    currentTime, duration, paused: true, seeking: false, ended: false, readyState: 4, playbackRate: 1,
    pause: vi.fn(() => { element.paused = true; }),
    play: vi.fn(() => { element.paused = false; return Promise.resolve(); })
  };
  return element;
}
function player(offset = 0, video = media(), audio = media()) {
  let mounted: (() => (() => void)) | undefined;
  const onplay = vi.fn(), clearInterval = vi.fn(), setInterval = vi.fn(() => 1);
  const context: Record<string, any> = {
    $props: () => ({ videoSrc: '/movie.mp4', audioSrc: '/french.m4a', offset, onplay }),
    $state: (value: unknown) => value, $derived: (value: unknown) => value,
    onMount: (callback: typeof mounted) => { mounted = callback; }, setInterval, clearInterval, WeakSet
  };
  const script = source.split('<script lang="ts">')[1].split('</script>')[0]
    .replace(/^\s*import .+;\s*$/gm, '').replace('export function pause()', 'function pause()')
    .replace(/const ready = \$derived\((.*)\);/, "Object.defineProperty(globalThis, 'ready', { get: () => $1 });");
  runInNewContext(transpile(`${script}\nglobalThis.player = {
    synchronize, toggle, seek, setOffset, pause, fail,
    setup: (v, a) => { video = v; audio = a; videoDuration = v.duration; audioDuration = a.duration; },
    speed: (value) => { rate = value; },
    state: () => ({ playing, buffering, failed, position, offset })
  };`), context);
  context.player.setup(video, audio);
  const destroy = mounted!();
  return { ...context.player, video, audio, onplay, destroy, setInterval, clearInterval };
}

describe('synchronized French soundtrack playback', () => {
  it('starts both tracks at the whole movie position and pauses both together', () => {
    const ui = player(0, media(42));
    ui.toggle();
    expect(ui.audio.currentTime).toBe(42);
    expect(ui.video.play).toHaveBeenCalledOnce();
    expect(ui.audio.play).toHaveBeenCalledOnce();
    expect(ui.onplay).toHaveBeenCalledOnce();
    ui.toggle();
    expect(ui.state().playing).toBe(false);
    expect(ui.video.paused).toBe(true);
    expect(ui.audio.paused).toBe(true);
  });

  it('keeps delayed audio silent, then starts it at video time minus offset', async () => {
    const ui = player(2);
    ui.toggle();
    expect(ui.video.paused).toBe(false);
    expect(ui.audio.paused).toBe(true);
    expect(ui.audio.currentTime).toBe(0);
    await Promise.resolve(); await Promise.resolve();
    ui.video.currentTime = 2.25;
    ui.synchronize();
    expect(ui.audio.currentTime).toBe(0.25);
    expect(ui.audio.paused).toBe(false);
  });

  it('advances a negative offset by trimming the beginning of the audio', () => {
    const ui = player(-2.5);
    ui.toggle();
    expect(ui.audio.currentTime).toBe(2.5);
    expect(ui.audio.paused).toBe(false);
  });

  it('silences audio after its end while continuing the movie', () => {
    const ui = player(0, media(25), media(0, 20));
    ui.toggle();
    expect(ui.audio.currentTime).toBe(20);
    expect(ui.audio.paused).toBe(true);
    expect(ui.video.paused).toBe(false);
  });

  it('corrects drift and applies a 10 ms offset change immediately while paused', () => {
    const ui = player(0, media(10), media(10));
    ui.synchronize();
    ui.audio.currentTime = 10.03;
    ui.synchronize();
    expect(ui.audio.currentTime).toBe(10.03);
    ui.audio.currentTime = 10.06;
    ui.synchronize();
    expect(ui.audio.currentTime).toBe(10);
    ui.setOffset(0.01);
    expect(ui.audio.currentTime).toBe(9.99);
    expect(ui.audio.paused).toBe(true);
  });

  it('preserves fine offset changes and short seeks until an in-flight audio seek finishes', () => {
    const ui = player(0, media(10), media(10));
    ui.synchronize();
    ui.audio.seeking = true;
    ui.setOffset(0.01);
    ui.setOffset(0.02);
    ui.synchronize();
    expect(ui.audio.currentTime).toBe(10);
    ui.audio.seeking = false;
    ui.synchronize();
    expect(ui.audio.currentTime).toBe(9.98);
    ui.audio.seeking = true;
    ui.seek(10.01);
    expect(ui.audio.currentTime).toBe(9.98);
    ui.audio.seeking = false;
    ui.synchronize();
    expect(ui.audio.currentTime).toBe(9.99);
  });

  it('does not repeatedly seek silent audio to its endpoints while idle', () => {
    const ui = player(2);
    const write = vi.fn();
    let position = 0;
    Object.defineProperty(ui.audio, 'currentTime', { get: () => position, set: (value) => { position = value; write(value); } });
    ui.synchronize(); ui.synchronize();
    expect(write).not.toHaveBeenCalled();
    ui.video.currentTime = 200;
    ui.synchronize(); ui.synchronize();
    expect(write).toHaveBeenCalledExactlyOnceWith(ui.audio.duration);
  });

  it('seeks the complete movie, clamps endpoints and ignores invalid offset input', () => {
    const ui = player(1, media(0, 600), media(0, 600));
    ui.seek(400);
    expect(ui.video.currentTime).toBe(400);
    expect(ui.audio.currentTime).toBe(399);
    ui.seek(700); expect(ui.video.currentTime).toBe(600);
    ui.seek(-10); expect(ui.video.currentTime).toBe(0);
    ui.seek(NaN); expect(ui.video.currentTime).toBe(0);
    ui.setOffset(NaN); expect(ui.state().offset).toBe(1);
    ui.setOffset(0.010000001); expect(ui.state().offset).toBe(0.01);
    ui.setOffset(601); expect(ui.state().offset).toBe(600);
    ui.setOffset(-601); expect(ui.state().offset).toBe(-600);
  });

  it('starts loading during the user gesture even if preload only supplied metadata', () => {
    const video = media(), audio = media();
    video.readyState = audio.readyState = 1;
    const ui = player(0, video, audio);
    ui.toggle();
    expect(video.play).toHaveBeenCalledOnce();
    expect(audio.play).toHaveBeenCalledOnce();
    expect(ui.state()).toMatchObject({ playing: true, buffering: true });
  });

  it('pauses both tracks during buffering or seeking and resumes with matching speed', async () => {
    const ui = player();
    ui.toggle();
    await Promise.resolve(); await Promise.resolve();
    ui.audio.readyState = 2;
    ui.synchronize();
    expect(ui.video.paused).toBe(true);
    expect(ui.audio.paused).toBe(true);
    expect(ui.state()).toMatchObject({ playing: true, buffering: true });
    ui.audio.readyState = 4;
    ui.speed(0.5); ui.synchronize();
    expect(ui.video.paused).toBe(false);
    expect(ui.audio.paused).toBe(false);
    expect(ui.video.playbackRate).toBe(0.5);
    expect(ui.audio.playbackRate).toBe(0.5);
    ui.video.seeking = true;
    ui.synchronize();
    expect(ui.video.paused).toBe(true);
    expect(ui.audio.paused).toBe(true);
  });

  it('reports rejected playback and pauses both tracks', async () => {
    const audio = media();
    audio.play.mockRejectedValueOnce(Object.assign(new Error('blocked'), { name: 'NotAllowedError' }));
    const ui = player(0, media(), audio);
    ui.toggle();
    await Promise.resolve(); await Promise.resolve();
    expect(ui.state()).toMatchObject({ playing: false, failed: true });
    expect(ui.video.paused).toBe(true);
    expect(ui.audio.paused).toBe(true);
  });

  it('cleans up the sync timer and pauses both tracks when unmounted', () => {
    const ui = player();
    ui.toggle(); ui.destroy();
    expect(ui.clearInterval).toHaveBeenCalledWith(1);
    expect(ui.setInterval).toHaveBeenCalledWith(expect.any(Function), 50);
    expect(ui.video.paused).toBe(true);
    expect(ui.audio.paused).toBe(true);
  });
});
