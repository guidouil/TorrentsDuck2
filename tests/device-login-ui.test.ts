import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transpile } from 'typescript';
import qrcode from 'qrcode-generator';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function componentScript(path: string) {
  return readFileSync(new URL(path, import.meta.url), 'utf8').split('<script lang="ts">')[1].split('</script>')[0].replace(/^\s*import .+;\s*$/gm, '');
}

function mountLogin(fetch = vi.fn(), code = '', api = vi.fn().mockResolvedValue({ device_code: 'private-device-code', user_code: 'ABCD1234', expires_in: 30, interval: 5 })) {
  let cleanup = () => {};
  const goto = vi.fn().mockResolvedValue(undefined);
  const context: Record<string, any> = {
    api, fetch, goto, invalidateAll: vi.fn(), qrcode, URL, AbortController, Date,
    setTimeout, clearTimeout, setInterval, clearInterval,
    window: { location: { origin: 'https://duck.example.com' } },
    page: { url: new URL(`https://duck.example.com/login?user_code=${encodeURIComponent(code)}`) },
    onMount: (callback: () => () => void) => { cleanup = callback(); },
    $state: (value: unknown) => value, $derived: (value: unknown) => value
  };
  const script = componentScript('../src/routes/login/+page.svelte');
  runInNewContext(transpile(`${script}\nglobalThis.login = { startDevice, cancelDevice, submit, state: () => ({ deviceStatus, reconnecting, qrImage }) };`), context);
  return { api, fetch, goto, cleanup: () => cleanup(), ...context.login as { startDevice: () => Promise<void>; cancelDevice: () => void; submit: (event: { preventDefault: () => void }) => Promise<void>; state: () => { deviceStatus: string; reconnecting: boolean; qrImage: string } } };
}

const response = (error: string, status = 400) => ({ ok: false, status, json: async () => ({ error }) });

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('QR login on the receiving screen', () => {
  it('polls until approved then refreshes account data once', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response('authorization_pending')).mockResolvedValue({ ok: true, json: async () => ({}) });
    const login = mountLogin(fetch);
    await login.startDevice();
    const svg = decodeURIComponent(login.state().qrImage.split(',')[1]);
    expect(svg).toContain('<svg');
    expect(login.api).toHaveBeenCalledWith('/api/auth/device/code', expect.objectContaining({ body: JSON.stringify({ client_id: 'torrents-duck-tv' }) }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(login.goto).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000);
    expect(login.goto).toHaveBeenCalledExactlyOnceWith('/', { refreshAll: true, replace: true });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('obeys slow_down and retries network failures only until expiry', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response('slow_down')).mockRejectedValue(new Error('offline'));
    const login = mountLogin(fetch);
    await login.startDevice();
    await vi.advanceTimersByTimeAsync(14_999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(login.state().reconnecting).toBe(true);
    await vi.advanceTimersByTimeAsync(45_000);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(login.state().deviceStatus).toBe('expired');
    expect(login.goto).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['cancel', 'unmount', 'expire'])('aborts a slow request without overlapping polls on %s', async (action) => {
    let resolveToken!: (value: unknown) => void;
    const fetch = vi.fn().mockImplementation(() => new Promise((resolve) => { resolveToken = resolve; }));
    const login = mountLogin(fetch);
    await login.startDevice();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    if (action === 'cancel') login.cancelDevice();
    else if (action === 'unmount') login.cleanup();
    else await vi.advanceTimersByTimeAsync(15_000);
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
    resolveToken({ ok: true, json: async () => ({}) });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(login.goto).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops when the phone denies the connection', async () => {
    const login = mountLogin(vi.fn().mockResolvedValue(response('access_denied')));
    await login.startDevice();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(login.fetch).toHaveBeenCalledTimes(1);
    expect(login.state().deviceStatus).toBe('denied');
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([['ABCD1234', '/login/device?user_code=ABCD1234'], ['https://evil.example/path', '/'], ['//evil.example', '/']])('continues login only to a local approval code: %s', async (code, destination) => {
    const login = mountLogin(vi.fn(), code);
    await login.submit({ preventDefault: vi.fn() });
    expect(login.goto).toHaveBeenCalledExactlyOnceWith(destination);
  });
});

describe('explicit approval on the phone', () => {
  function mountPhone(device: Record<string, unknown>, user = { enabled: true, approved: true }) {
    const api = vi.fn().mockResolvedValue(device);
    const context: Record<string, any> = {
      api, $t: { deviceUnavailable: 'Unavailable' },
      $props: () => ({ data: { userCode: 'ABCD1234', user } }),
      $state: (value: unknown) => value, $derived: (value: unknown) => value,
      onMount: (callback: () => () => void) => callback()
    };
    runInNewContext(transpile(`${componentScript('../src/routes/login/device/+page.svelte')}\nglobalThis.phone = { decide, state: () => ({ ready, result }) };`), context);
    return { api, ...context.phone as { decide: (approve: boolean) => Promise<void>; state: () => { ready: boolean; result: string } } };
  }

  it('only claims the code on opening, and approves after an explicit action', async () => {
    const phone = mountPhone({ user_code: 'ABCD1234', status: 'pending', client_id: 'torrents-duck-tv' });
    await vi.advanceTimersByTimeAsync(0);
    expect(phone.api).toHaveBeenCalledExactlyOnceWith('/api/auth/device?user_code=ABCD1234');
    expect(phone.state().ready).toBe(true);
    await phone.decide(true);
    expect(phone.api).toHaveBeenLastCalledWith('/api/auth/device/approve', { method: 'POST', body: JSON.stringify({ userCode: 'ABCD1234' }) });
    expect(phone.state().result).toBe('approved');
  });

  it.each([
    { user_code: 'ABCD1234', status: 'approved', client_id: 'torrents-duck-tv' },
    { user_code: 'ABCD1234', status: 'pending', client_id: 'other-client' },
    { user_code: 'WRONG123', status: 'pending', client_id: 'torrents-duck-tv' }
  ])('does not offer approval for another or completed request', async (device) => {
    const phone = mountPhone(device);
    await vi.advanceTimersByTimeAsync(0);
    expect(phone.state().ready).toBe(false);
  });

  it.each([{ enabled: false, approved: true }, { enabled: true, approved: false }])('does not claim a code for an ineligible account', async (user) => {
    const phone = mountPhone({}, user);
    await vi.advanceTimersByTimeAsync(0);
    expect(phone.api).not.toHaveBeenCalled();
  });
});
