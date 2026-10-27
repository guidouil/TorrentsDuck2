import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { compile } from 'svelte/compiler';
// @ts-expect-error Compiled SSR output uses this runtime, which has no public declarations.
import * as server from 'svelte/internal/server';
import { render } from 'svelte/server';
import { transpile } from 'typescript';
import { describe, expect, it, vi } from 'vitest';

function mountChat(api = vi.fn().mockResolvedValue({ messages: [], nextCursor: null })) {
  const script = readFileSync(new URL('../src/routes/(app)/chat/+page.svelte', import.meta.url), 'utf8')
    .split('<script lang="ts">')[1].split('</script>')[0].replace(/^\s*import .+;\s*$/gm, '');
  const context: Record<string, any> = {
    api, URL, onMount: vi.fn(), tick: vi.fn().mockResolvedValue(undefined),
    $state: (value: unknown) => value
  };
  runInNewContext(transpile(`${script}\nglobalThis.chat = { keydown, send, shortName, messageParts, input: (value) => { body = value; }, state: () => ({ body, busy, error, messages }) };`), context);
  return { api, event: { preventDefault: vi.fn() }, ...context.chat };
}

function keyEvent(overrides = {}) {
  return {
    key: 'Enter', shiftKey: false, isComposing: false, keyCode: 13, repeat: false,
    preventDefault: vi.fn(), currentTarget: { form: { requestSubmit: vi.fn() } }, ...overrides
  };
}

describe('chat links', () => {
  it('renders escaped message content and links that open safely in a new tab', () => {
    const component = readFileSync(new URL('../src/routes/(app)/chat/+page.svelte', import.meta.url), 'utf8');
    const markup = component.match(/<p>\{#each messageParts\(message.body\)[\s\S]*?<\/p>/)![0];
    const compiled = compile(`<script>let { message, messageParts } = $props();</script>${markup}`, { generate: 'server', filename: 'Message.svelte' }).js.code
      .replace(/^import .+;\s*$/gm, '').replace('export default function', 'function');
    const Message = runInNewContext(`${compiled}\nMessage;`, { $: server });
    const { body } = render(Message, { props: {
      message: { body: '<img src=x onerror=alert(1)> https://example.com/?a=1&b=2' },
      messageParts: mountChat().messageParts
    } });
    expect(body).toContain('&lt;img src=x onerror=alert(1)>');
    expect(body).not.toContain('<img');
    expect(body).toContain('<a href="https://example.com/?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">https://example.com/?a=1&amp;b=2</a>');
  });

  it('recognizes web links while preserving all text and line breaks', () => {
    const body = 'Voir https://example.com/search?q=duck&lang=fr,\nhttp://example.org et WWW.example.net/docs#intro.';
    const parts = mountChat().messageParts(body);
    expect(parts.filter((part: any) => part.href)).toEqual([
      { text: 'https://example.com/search?q=duck&lang=fr', href: 'https://example.com/search?q=duck&lang=fr' },
      { text: 'http://example.org', href: 'http://example.org' },
      { text: 'WWW.example.net/docs#intro', href: 'https://WWW.example.net/docs#intro' }
    ]);
    expect(parts.map((part: any) => part.text).join('')).toBe(body);
  });

  it.each([
    ['(https://example.com/page).', 'https://example.com/page'],
    ['[https://example.com/page]!', 'https://example.com/page'],
    ['https://example.com/wiki/Duck_(bird)', 'https://example.com/wiki/Duck_(bird)'],
    ['(https://example.com/wiki/Duck_(bird)).', 'https://example.com/wiki/Duck_(bird)'],
    ['<https://example.com>', 'https://example.com'],
    ['«https://example.org»', 'https://example.org']
  ])('handles punctuation around %s', (body, expected) => {
    const parts = mountChat().messageParts(body);
    expect(parts.find((part: any) => part.href)?.href).toBe(expected);
    expect(parts.map((part: any) => part.text).join('')).toBe(body);
  });

  it.each(['', 'Texte simple\nDeuxième ligne', 'javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'http:// https:// www. https://[invalid]', '<img src=x onerror=alert(1)>'])('leaves invalid URLs and unsafe content as text: %s', (body) => {
    const parts = mountChat().messageParts(body);
    expect(parts.some((part: any) => part.href)).toBe(false);
    expect(parts.map((part: any) => part.text).join('')).toBe(body);
  });
});

describe('chat mobile names', () => {
  it.each([
    ['member', 'member'],
    ['abcdefg', 'abcdefg'],
    ['abcdefgh', 'abcdefgh'],
    ['abcdefghi', 'abcdefg…'],
    ['averylongmembername', 'averylo…'],
    ['abcdef😀h', 'abcdef😀h'],
    ['abcdef😀hi', 'abcdef😀…'],
    ['abcdefe\u0301hi', 'abcdefe\u0301…']
  ])('formats %s as %s', (name, expected) => {
    expect(mountChat().shortName(name)).toBe(expected);
  });
});

describe('chat keyboard shortcuts', () => {
  it('submits the form on Enter without inserting a newline', () => {
    const chat = mountChat();
    const event = keyEvent();
    chat.keydown(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.currentTarget.form.requestSubmit).toHaveBeenCalledOnce();
  });

  it.each([
    { shiftKey: true },
    { isComposing: true },
    { keyCode: 229 },
    { key: 'a' }
  ])('preserves native editing for %j', (overrides) => {
    const chat = mountChat();
    const event = keyEvent(overrides);
    chat.keydown(event);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.currentTarget.form.requestSubmit).not.toHaveBeenCalled();
  });

  it('ignores repeated Enter presses without inserting newlines', () => {
    const chat = mountChat();
    const event = keyEvent({ repeat: true });
    chat.keydown(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.currentTarget.form.requestSubmit).not.toHaveBeenCalled();
  });
});

describe('chat submission', () => {
  it.each(['', ' \n\t '])('ignores an empty message %j', async (body) => {
    const chat = mountChat();
    chat.input(body);
    await chat.send(chat.event);
    expect(chat.api).not.toHaveBeenCalled();
    expect(chat.state()).toMatchObject({ body, busy: false, error: '' });
  });

  it('sends multiline text, clears it after success and refreshes the messages', async () => {
    const message = { id: '1', name: 'Member', body: 'First line\nSecond line', createdAt: '2026-01-01T12:00:00.000Z' };
    const chat = mountChat(vi.fn().mockResolvedValueOnce({ message }).mockResolvedValue({ messages: [message], nextCursor: null }));
    chat.input(message.body);
    await chat.send(chat.event);
    expect(chat.event.preventDefault).toHaveBeenCalledOnce();
    expect(chat.api).toHaveBeenNthCalledWith(1, '/api/chat', { method: 'POST', body: JSON.stringify({ body: message.body }) });
    expect(chat.api).toHaveBeenNthCalledWith(2, '/api/chat');
    expect(chat.state()).toMatchObject({ body: '', busy: false, error: '', messages: [message] });
  });

  it('ignores a second submission while the first message is pending', async () => {
    let complete!: () => void;
    const api = vi.fn().mockImplementationOnce(() => new Promise<void>((resolve) => { complete = resolve; }))
      .mockResolvedValue({ messages: [], nextCursor: null });
    const chat = mountChat(api);
    chat.input('One message');
    const pending = chat.send(chat.event);
    await chat.send(chat.event);
    expect(api).toHaveBeenCalledOnce();
    expect(chat.state()).toMatchObject({ body: 'One message', busy: true });
    complete();
    await pending;
    expect(api.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
    expect(chat.state()).toMatchObject({ body: '', busy: false, error: '' });
  });

  it('keeps a rejected message available for a successful retry', async () => {
    const chat = mountChat(vi.fn().mockRejectedValueOnce(new Error('Message rejected'))
      .mockResolvedValue({ messages: [], nextCursor: null }));
    chat.input('Retry this message');
    await chat.send(chat.event);
    expect(chat.state()).toMatchObject({ body: 'Retry this message', busy: false, error: 'Message rejected' });
    expect(chat.api).toHaveBeenCalledOnce();
    await chat.send(chat.event);
    expect(chat.api).toHaveBeenNthCalledWith(2, '/api/chat', { method: 'POST', body: JSON.stringify({ body: 'Retry this message' }) });
    expect(chat.state()).toMatchObject({ body: '', busy: false, error: '' });
  });
});
