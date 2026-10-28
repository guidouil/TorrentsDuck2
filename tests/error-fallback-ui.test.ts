import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { get } from 'svelte/store';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { language, t } from '../src/lib/i18n';

const template = readFileSync(new URL('../src/error.html', import.meta.url), 'utf8');

function renderFallback(status: number, preferences: Record<string, string> = {}, storageUnavailable = false, soundUnavailable = false) {
  const html = template.replaceAll('%sveltekit.status%', String(status));
  const elements = Object.fromEntries([...html.matchAll(/<([a-z][a-z0-9]*)\b[^>]*\bid="([^"]+)"([^>]*)>([^<]*)/g)].map((match) => [match[2], {
    textContent: match[4], hidden: /\bhidden\b/.test(match[3]), title: '', attributes: {} as Record<string, string>,
    setAttribute(name: string, value: string) { this.attributes[name] = value; },
    addEventListener: vi.fn()
  }]));
  const audio = Object.assign(elements['quack-audio'], {
    currentTime: 3,
    play: vi.fn(() => soundUnavailable ? Promise.reject(new Error('Audio unavailable')) : Promise.resolve())
  });
  const document = {
    title: '', body: { dataset: { status: String(status) } },
    documentElement: { lang: 'fr', dataset: { theme: 'dark' } },
    getElementById: (id: string) => elements[id]
  };
  const context = {
    document,
    localStorage: { getItem: (key: string) => { if (storageUnavailable) throw new Error('Storage unavailable'); return preferences[key] ?? null; } }
  };
  for (const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) runInNewContext(script[1], context);
  return { html, document, elements, audio };
}

afterEach(() => language.set('fr'));

describe('static error fallback', () => {
  it.each([400, 403, 500])('keeps status %i and a safe way home without JavaScript', (status) => {
    const html = template.replaceAll('%sveltekit.status%', String(status));
    const labels = get(t);
    expect(html).toContain(`<title>${status} · ${labels.errorTitle} · TorrentsDuck2</title>`);
    expect(html).toContain(`TorrentsDuck2 · ${status}</p>`);
    expect(html).toContain(`data-status="${status}"`);
    expect(html).toContain(labels.errorDescription);
    expect(html).toContain(`href="/">${labels.backHome}</a>`);
    expect(html).toContain('content="noindex,nofollow"');
    expect(html).not.toContain('%sveltekit.error.message%');
    expect(html).not.toMatch(/<script[^>]+src=|<link[^>]+stylesheet|autoplay/);
  });

  it.each([400, 403, 416, 429, 500])('renders every real digit of %i around the duck', (status) => {
    const { elements } = renderFallback(status);
    expect(['first-digit', 'middle-digit', 'last-digit'].map((id) => elements[id].textContent).join('')).toBe(String(status));
    expect(elements.pond.hidden).toBe(false);
    expect(elements['last-digit'].hidden).toBe(false);
  });

  it.each(['fr', 'en'] as const)('restores the saved language and light theme in %s', (locale) => {
    language.set(locale);
    const labels = get(t);
    const { document, elements } = renderFallback(503, { language: locale, theme: 'light' });
    expect(document.documentElement).toEqual({ lang: locale, dataset: { theme: 'light' } });
    expect(document.title).toBe(`503 · ${labels.errorTitle} · TorrentsDuck2`);
    expect(elements['error-title'].textContent).toBe(labels.errorTitle);
    expect(elements['error-description'].textContent).toBe(labels.errorDescription);
    expect(elements['back-home'].textContent).toBe(labels.backHome);
    if (locale === 'en') expect(elements['quack-button'].attributes['aria-label']).toBe(labels.quack);
  });

  it.each([false, true])('keeps working with defaults when storage is unavailable: %s', (storageUnavailable) => {
    const { document, elements } = renderFallback(500, {}, storageUnavailable);
    expect(document.documentElement).toEqual({ lang: 'fr', dataset: { theme: 'dark' } });
    expect(elements['error-title'].textContent).toBe(get(t).errorTitle);
    expect(elements['quack-button'].addEventListener).toHaveBeenCalledWith('click', expect.any(Function));
  });

  it.each([false, true])('plays audio only on activation and handles unavailable sound: %s', async (soundUnavailable) => {
    const { elements, audio } = renderFallback(400, {}, false, soundUnavailable);
    expect(audio.play).not.toHaveBeenCalled();
    const click = elements['quack-button'].addEventListener.mock.calls[0][1] as () => void;
    expect(click).not.toThrow();
    expect(audio.currentTime).toBe(0);
    audio.currentTime = 2;
    click();
    expect(audio.currentTime).toBe(0);
    await new Promise(setImmediate);
    expect(audio.play).toHaveBeenCalledTimes(2);
  });
});
