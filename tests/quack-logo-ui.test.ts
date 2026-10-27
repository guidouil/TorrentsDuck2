import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transpile } from 'typescript';
import { describe, expect, it, vi } from 'vitest';

function mount(audioElement: { currentTime: number; play: () => Promise<void> }) {
  const script = readFileSync(new URL('../src/lib/QuackLogo.svelte', import.meta.url), 'utf8')
    .split('<script lang="ts">')[1].split('</script>')[0].replace(/^\s*import .+;\s*$/gm, '');
  return runInNewContext(transpile(`${script}\naudio = audioElement;\nquack;`), {
    audioElement, $props: () => ({ href: '/' })
  }) as () => void;
}

describe('duck logo sound', () => {
  it('restarts the sound before playing on every click', () => {
    const audio = { currentTime: 3, play: vi.fn(() => { expect(audio.currentTime).toBe(0); return Promise.resolve(); }) };
    const quack = mount(audio);
    quack();
    audio.currentTime = 2;
    quack();
    expect(audio.play).toHaveBeenCalledTimes(2);
    expect(audio.currentTime).toBe(0);
  });

  it('handles unavailable browser audio without an unhandled rejection', async () => {
    const audio = { currentTime: 3, play: vi.fn().mockRejectedValue(new Error('Audio unavailable')) };
    const quack = mount(audio);
    expect(quack).not.toThrow();
    await new Promise(setImmediate);
    expect(audio.play).toHaveBeenCalledOnce();
    expect(audio.currentTime).toBe(0);
  });
});
