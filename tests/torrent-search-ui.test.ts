import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transpile } from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';

function mountSearch(api: ReturnType<typeof vi.fn>, enabled = true) {
  let mount = () => () => {};
  let derived = 0;
  const script = readFileSync(new URL('../src/routes/(app)/search/+page.svelte', import.meta.url), 'utf8').split('<script lang="ts">')[1].split('</script>')[0].replace(/^\s*import .+;\s*$/gm, '');
  const context: Record<string, any> = {
    api, setTimeout, clearTimeout, URLSearchParams,
    $t: { torrentAdded: 'Added', searchSizeRange: 'Invalid size range' },
    $props: () => ({ data: { user: { role: 'member', canManageSources: false } } }),
    onMount: (callback: () => () => void) => { mount = callback; },
    $state: (value: unknown) => value,
    $derived: (value: unknown) => Array.isArray(value) && derived++ === 0 ? enabled ? [{ id: 'source', installed: true, enabled: true }] : [] : value
  };
  runInNewContext(transpile(`${script}\nglobalThis.search = { startSearch, poll, add, applyFilters, query: (value) => { query = value; }, controls: (value) => { sort = value.sort; minSeeders = value.minSeeders; minSize = value.minSize; maxSize = value.maxSize; currentPage = value.page ?? 1; }, state: () => ({ searchId, results, running, starting, error, added, adding, notice, currentPage, diagnostic, sourceDiagnostics }) };`), context);
  return { ...context.search, mount: () => mount(), event: { preventDefault: vi.fn() } };
}

function defaultAPI() {
  return vi.fn().mockImplementation(async (url: string, options?: RequestInit) => {
    if (url === '/api/search/sources') return { sources: [], canManage: false };
    if (url === '/api/search' && options?.method === 'POST') return { id: 'current' };
    if (url.startsWith('/api/search?')) return { results: [], total: 0, running: false };
    return { ok: true };
  });
}

afterEach(() => vi.useRealTimers());

describe('torrent search lifecycle', () => {
  it('ignores empty searches and searches without enabled sources', async () => {
    const api = defaultAPI();
    const empty = mountSearch(api);
    empty.query(' \n ');
    await empty.startSearch(empty.event);
    const unavailable = mountSearch(api, false);
    unavailable.query('Ubuntu');
    await unavailable.startSearch(unavailable.event);
    expect(api).not.toHaveBeenCalled();
  });

  it('prevents duplicate submissions and deletes a job returned after navigation away', async () => {
    let complete!: (value: { id: string }) => void;
    const api = defaultAPI().mockImplementation(async (url: string, options?: RequestInit) => {
      if (url === '/api/search/sources') return { sources: [], canManage: false };
      if (options?.method === 'POST') return new Promise((resolve) => { complete = resolve; });
      return { ok: true };
    });
    const search = mountSearch(api);
    const unmount = search.mount();
    search.query('Ubuntu');
    const pending = search.startSearch(search.event);
    await search.startSearch(search.event);
    expect(api.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
    unmount();
    complete({ id: 'late-job' });
    await pending;
    expect(api).toHaveBeenCalledWith('/api/search', expect.objectContaining({ method: 'DELETE', body: JSON.stringify({ id: 'late-job' }) }));
    expect(api.mock.calls.some(([url]) => url.startsWith('/api/search?'))).toBe(false);
  });

  it('ignores a previous result request after a newer search starts', async () => {
    let complete!: (value: unknown) => void;
    const api = defaultAPI().mockImplementation(async (url: string, options?: RequestInit) => {
      if (url.includes('id=old')) return new Promise((resolve) => { complete = resolve; });
      if (options?.method === 'POST') return { id: 'new' };
      return { results: [{ name: 'new result' }], total: 1, running: false };
    });
    const search = mountSearch(api);
    const oldRequest = search.poll('old', 0);
    search.query('Ubuntu');
    await search.startSearch(search.event);
    complete({ results: [{ name: 'old result' }], total: 1, running: true });
    await oldRequest;
    expect(search.state().results).toEqual([{ name: 'new result' }]);
    expect(search.state().running).toBe(false);
  });

  it('cancels polling and removes the current search on unmount', async () => {
    vi.useFakeTimers();
    const api = defaultAPI().mockImplementation(async (url: string, options?: RequestInit) => {
      if (url === '/api/search/sources') return { sources: [], canManage: false };
      if (options?.method === 'POST') return { id: 'running' };
      if (url.startsWith('/api/search?')) return { results: [], total: 0, running: true };
      return { ok: true };
    });
    const search = mountSearch(api);
    const unmount = search.mount();
    search.query('Ubuntu');
    await search.startSearch(search.event);
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    await vi.advanceTimersByTimeAsync(2000);
    expect(api.mock.calls.filter(([url]) => url.startsWith('/api/search?'))).toHaveLength(1);
    expect(api).toHaveBeenCalledWith('/api/search', expect.objectContaining({ method: 'DELETE', body: JSON.stringify({ id: 'running' }) }));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('allows retrying a failed add and marks only successful additions', async () => {
    const api = defaultAPI().mockRejectedValueOnce(new Error('Disk reserve')).mockResolvedValue({ ok: true });
    const search = mountSearch(api);
    const result = { url: 'magnet:?xt=urn:btih:0123456789012345678901234567890123456789' };
    await search.add(result);
    expect(search.state()).toMatchObject({ added: [], adding: '', error: 'Disk reserve' });
    await search.add(result);
    await search.add(result);
    expect(api).toHaveBeenCalledTimes(2);
    expect(api).toHaveBeenLastCalledWith('/api/torrents', { method: 'POST', body: JSON.stringify({ source: result.url }) });
    expect(search.state()).toMatchObject({ added: [result.url], notice: 'Added' });
  });

  it('requests global sorting and size filters in bytes from the first page', async () => {
    const api = defaultAPI();
    const search = mountSearch(api);
    search.query('Ubuntu');
    await search.startSearch(search.event);
    search.controls({ sort: 'date', minSeeders: 5, minSize: 1.5, maxSize: 4, page: 3 });
    search.applyFilters();
    const [url] = api.mock.calls.at(-1)!;
    const params = new URL(`http://localhost${url}`).searchParams;
    expect(Object.fromEntries(params)).toEqual({ id: 'current', offset: '0', sort: 'date', minSeeders: '5', minSize: String(1.5 * 1024 ** 3), maxSize: String(4 * 1024 ** 3) });
    expect(search.state().currentPage).toBe(1);
  });

  it('keeps the current query when the minimum size exceeds the maximum', async () => {
    const api = defaultAPI();
    const search = mountSearch(api);
    search.query('Ubuntu');
    await search.startSearch(search.event);
    api.mockClear();
    search.controls({ sort: 'seeders', minSize: 4, maxSize: 1 });
    search.applyFilters();
    expect(api).not.toHaveBeenCalled();
    expect(search.state().error).toBe('Invalid size range');
  });

  it('preserves a source diagnostic alongside results from healthy sources', async () => {
    const diagnostics = [{ source: 'Example', message: 'Unsupported format', diagnostic: 'Safe report' }];
    const api = defaultAPI().mockResolvedValue({ results: [{ name: 'Ubuntu' }], total: 1, running: false, diagnostics });
    const search = mountSearch(api);
    await search.poll('current', 0);
    expect(search.state()).toMatchObject({ results: [{ name: 'Ubuntu' }], sourceDiagnostics: diagnostics });
  });

  it('keeps the protected torrent-add diagnostic without including the result token', async () => {
    const api = defaultAPI().mockRejectedValue(Object.assign(new Error('Source failed'), { diagnostic: 'Safe report' }));
    const search = mountSearch(api);
    await search.add({ url: 'search:private-token:0' });
    expect(search.state()).toMatchObject({ diagnostic: 'Safe report', error: 'Source failed' });
    expect(search.state().diagnostic).not.toContain('private-token');
  });
});
