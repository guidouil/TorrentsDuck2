import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transpile } from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const component = readFileSync(new URL('../src/routes/waiting/+page.svelte', import.meta.url), 'utf8');
const script = transpile(component.split('<script lang="ts">')[1].split('</script>')[0].replace(/^\s*import .+;\s*$/gm, ''));

function mount(api: ReturnType<typeof vi.fn>, goto = vi.fn().mockResolvedValue(undefined)) {
  let cleanup = () => {};
  runInNewContext(script, {
    api, goto, setTimeout, clearTimeout,
    onMount: (callback: () => () => void) => { cleanup = callback(); },
    $props: () => ({ data: { user: { role: 'member' } } }),
    $state: (value: unknown) => value,
    $derived: (value: unknown) => value
  });
  return { goto, cleanup: () => cleanup() };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('account approval on the waiting page', () => {
  it('checks immediately and opens home with fresh layout data as soon as approval is detected', async () => {
    const api = vi.fn().mockResolvedValueOnce({ user: { enabled: true, approved: false } }).mockResolvedValue({ user: { enabled: true, approved: true } });
    const { goto } = mount(api);
    expect(api).toHaveBeenCalledWith('/api/auth/get-session?disableCookieCache=true');
    await vi.advanceTimersByTimeAsync(1999);
    expect(goto).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(goto).toHaveBeenCalledExactlyOnceWith('/', { refreshAll: true, replace: true });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(api).toHaveBeenCalledTimes(2);
  });

  it.each([null, { user: { enabled: false, approved: true } }])('sends an expired or disabled session to login', async (session) => {
    const { goto } = mount(vi.fn().mockResolvedValue(session));
    await vi.advanceTimersByTimeAsync(0);
    expect(goto).toHaveBeenCalledExactlyOnceWith('/login', { refreshAll: true, replace: true });
  });

  it('retries after a connection error without overlapping slow requests', async () => {
    let resolveSession!: (value: unknown) => void;
    const api = vi.fn().mockRejectedValueOnce(new Error('offline')).mockImplementationOnce(() => new Promise((resolve) => { resolveSession = resolve; }));
    const { goto, cleanup } = mount(api);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(api).toHaveBeenCalledTimes(2);
    resolveSession({ user: { enabled: true, approved: false } });
    await vi.advanceTimersByTimeAsync(0);
    expect(goto).not.toHaveBeenCalled();
    cleanup();
    await vi.advanceTimersByTimeAsync(2000);
    expect(api).toHaveBeenCalledTimes(2);
  });

  it('ignores a pending approval response after leaving the page', async () => {
    let resolveSession!: (value: unknown) => void;
    const { goto, cleanup } = mount(vi.fn().mockImplementation(() => new Promise((resolve) => { resolveSession = resolve; })));
    cleanup();
    resolveSession({ user: { enabled: true, approved: true } });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(goto).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
