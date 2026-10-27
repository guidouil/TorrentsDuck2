import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { compile } from 'svelte/compiler';
// @ts-expect-error Compiled SSR output uses this runtime, which has no public declarations.
import * as server from 'svelte/internal/server';
import { render } from 'svelte/server';
import { get } from 'svelte/store';
import { transpile } from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { language, t } from '../src/lib/i18n';

const component = readFileSync(new URL('../src/routes/+error.svelte', import.meta.url), 'utf8');
const compiled = compile(component, { generate: 'server', filename: '+error.svelte' }).js.code
  .replace(/^import .+;\s*$/gm, '').replace('export default function', 'function');
const internalMessage = 'Internal database details that must remain private';

function renderPage(status: number) {
  const ErrorPage = runInNewContext(`${compiled}\n_error;`, {
    $: server, t, page: { status, error: { message: internalMessage } }
  });
  return render(ErrorPage);
}

afterEach(() => language.set('fr'));

describe('error page', () => {
  it.each(['fr', 'en'] as const)('renders the duck 404 and a way home in %s', (locale) => {
    language.set(locale);
    const labels = get(t);
    const { body, head } = renderPage(404);
    expect(head).toContain(labels.notFoundTitle);
    expect(body).toContain(labels.notFoundTitle);
    expect(body).toContain(labels.notFoundDescription);
    expect(body).toContain(labels.backHome);
    expect(body).toMatch(/href="\/"/);
    expect(body).toContain(`aria-label="${labels.quack}"`);
    expect(body).toContain('src="/quack.mp3"');
    expect(body).not.toContain(internalMessage);
  });

  it.each([
    ['fr', 403], ['fr', 500], ['en', 500]
  ] as const)('renders a generic error in %s for status %i', (locale, status) => {
    language.set(locale);
    const labels = get(t);
    const { body, head } = renderPage(status);
    expect(head).toContain(labels.errorTitle);
    expect(body).toContain(String(status));
    expect(body).toContain(labels.errorTitle);
    expect(body).toContain(labels.errorDescription);
    expect(body).not.toContain(labels.notFoundTitle);
    expect(body).not.toContain(internalMessage);
    expect(body).toContain(labels.backHome);
  });

  it.each([false, true])('restarts the duck sound and handles unavailable audio: %s', async (unavailable) => {
    const audio = {
      currentTime: 3,
      play: vi.fn(() => unavailable ? Promise.reject(new Error('Audio unavailable')) : Promise.resolve())
    };
    const script = component.split('<script lang="ts">')[1].split('</script>')[0]
      .replace(/^\s*import .+;\s*$/gm, '');
    const quack = runInNewContext(transpile(`${script}\naudio = audioElement;\nquack;`), {
      audioElement: audio, page: { status: 404 }, $t: get(t),
      $derived: (value: unknown) => value, $state: (value: unknown) => value
    }) as () => void;
    expect(audio.play).not.toHaveBeenCalled();
    expect(quack).not.toThrow();
    expect(audio.currentTime).toBe(0);
    audio.currentTime = 2;
    quack();
    expect(audio.currentTime).toBe(0);
    await new Promise(setImmediate);
    expect(audio.play).toHaveBeenCalledTimes(2);
  });
});
