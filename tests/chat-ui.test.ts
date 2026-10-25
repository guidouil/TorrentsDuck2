import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transpile } from 'typescript';
import { describe, expect, it, vi } from 'vitest';

function mountChat(api = vi.fn().mockResolvedValue({ messages: [], nextCursor: null })) {
  const script = readFileSync(new URL('../src/routes/(app)/chat/+page.svelte', import.meta.url), 'utf8')
    .split('<script lang="ts">')[1].split('</script>')[0].replace(/^\s*import .+;\s*$/gm, '');
  const context: Record<string, any> = {
    api, onMount: vi.fn(), tick: vi.fn().mockResolvedValue(undefined),
    $state: (value: unknown) => value
  };
  runInNewContext(transpile(`${script}\nglobalThis.chat = { keydown, send, shortName, input: (value) => { body = value; }, state: () => ({ body, busy, error, messages }) };`), context);
  return { api, event: { preventDefault: vi.fn() }, ...context.chat };
}

function keyEvent(overrides = {}) {
  return {
    key: 'Enter', shiftKey: false, isComposing: false, keyCode: 13, repeat: false,
    preventDefault: vi.fn(), currentTarget: { form: { requestSubmit: vi.fn() } }, ...overrides
  };
}

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
