import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transpile } from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const component = readFileSync(new URL('../src/routes/(app)/+layout.svelte', import.meta.url), 'utf8');
const script = transpile(component.split('<script lang="ts">')[1].split('</script>')[0].replace(/^\s*import .+;\s*$/gm, ''));

function mount(api: ReturnType<typeof vi.fn>) {
  let cleanup = () => {};
  const goto = vi.fn().mockResolvedValue(undefined);
  runInNewContext(script, {
    api, goto, setTimeout, clearTimeout,
    localStorage: { getItem: () => null },
    onMount: (callback: () => () => void) => { cleanup = callback(); },
    $props: () => ({ data: { user: { id: 'member' } } }),
    $state: (value: unknown) => value, $effect: () => {}
  });
  return { goto, cleanup: () => cleanup() };
}

const active = { user: { enabled: true, approved: true } };

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('session revocation on every member page', () => {
  it('returns to login when another browser signs out, without waiting for a user action', async () => {
    const api = vi.fn().mockResolvedValueOnce(active).mockResolvedValue(null);
    const { goto } = mount(api);
    expect(api).toHaveBeenCalledWith('/api/auth/get-session?disableCookieCache=true');
    await vi.advanceTimersByTimeAsync(4999);
    expect(goto).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(goto).toHaveBeenCalledExactlyOnceWith('/login', { refreshAll: true, replace: true });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(api).toHaveBeenCalledTimes(2);
  });

  it.each([
    [null, '/login'],
    [{ user: { enabled: false, approved: true } }, '/login'],
    [{ user: { enabled: true, approved: false } }, '/waiting']
  ])('redirects invalid access to the appropriate page: %j', async (session, destination) => {
    const { goto } = mount(vi.fn().mockResolvedValue(session));
    await vi.advanceTimersByTimeAsync(0);
    expect(goto).toHaveBeenCalledExactlyOnceWith(destination, { refreshAll: true, replace: true });
  });

  it('retries network errors without logging out or overlapping a slow request', async () => {
    let resolveSession!: (value: unknown) => void;
    const api = vi.fn().mockRejectedValueOnce(new Error('offline')).mockImplementationOnce(() => new Promise((resolve) => { resolveSession = resolve; })).mockResolvedValue(active);
    const { goto, cleanup } = mount(api);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(api).toHaveBeenCalledTimes(2);
    expect(goto).not.toHaveBeenCalled();
    resolveSession(active);
    await vi.advanceTimersByTimeAsync(5000);
    expect(api).toHaveBeenCalledTimes(3);
    expect(goto).not.toHaveBeenCalled();
    cleanup();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(api).toHaveBeenCalledTimes(3);
  });

  it('ignores a response after leaving the member layout', async () => {
    let resolveSession!: (value: unknown) => void;
    const { goto, cleanup } = mount(vi.fn().mockImplementation(() => new Promise((resolve) => { resolveSession = resolve; })));
    cleanup();
    resolveSession(null);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(goto).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
