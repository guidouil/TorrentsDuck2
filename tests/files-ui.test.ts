import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transpile } from 'typescript';
import { describe, expect, it, vi } from 'vitest';

function explorer(url: string, shallowUrl?: string, api = vi.fn().mockResolvedValue({ entries: [], total: 0 })) {
  const goto = vi.fn();
  const script = readFileSync(new URL('../src/routes/(app)/files/+page.svelte', import.meta.url), 'utf8')
    .split('<script lang="ts">')[1].split('</script>')[0].replace(/^\s*import .+;\s*$/gm, '');
  const context: Record<string, any> = {
    URL, URLSearchParams, api, goto,
    page: { url: new URL(url), shallow: shallowUrl ? { url: new URL(shallowUrl) } : null },
    $state: (value: unknown) => value, $derived: (value: unknown) => value, $effect: () => {}
  };
  runInNewContext(transpile(`${script}\nglobalThis.explorer = { browse, enter, switchSpace, loadFiles, state: () => ({ space, path, query, sort, offset, entries, loading, error }) };`), context);
  return { api, goto, ...context.explorer as {
    browse: (values: Record<string, string>, replace?: boolean) => void;
    enter: (path: string) => void;
    switchSpace: (space: string) => void;
    loadFiles: () => Promise<void>;
    state: () => { space: string; path: string; query: string; sort: string; offset: number; entries: unknown[]; loading: boolean; error: string };
  } };
}

const origin = 'https://duck.example.com/files';
const shared = `${origin}?space=share&path=Films%2F%C3%89t%C3%A9+2026&search=version+longue&sort=size&offset=50`;

describe('file explorer URL navigation', () => {
  it.each([undefined, shared])('loads a bookmarked or shallow URL with all its explorer state (%s)', async (shallowUrl) => {
    const files = explorer(shallowUrl ? origin : shared, shallowUrl);
    expect(files.state()).toMatchObject({ space: 'share', path: 'Films/Été 2026', query: 'version longue', sort: 'size', offset: 50 });
    await files.loadFiles();
    const request = new URL(files.api.mock.calls[0][0], origin);
    expect(Object.fromEntries(request.searchParams)).toEqual({ space: 'share', path: 'Films/Été 2026', search: 'version longue', sort: 'size', offset: '50', limit: '50' });
  });

  it('keeps the space and sort when opening a folder, resets search and pagination, and restores them on back', () => {
    const files = explorer(shared);
    files.enter('Films/Été 2026/A & B #1');
    const [target, options] = files.goto.mock.calls[0];
    expect(target.pathname).toBe('/files');
    expect(Object.fromEntries(target.searchParams)).toEqual({ space: 'share', path: 'Films/Été 2026/A & B #1', sort: 'size' });
    expect(options).toEqual({ shallow: true, replace: false, reset: false });
    expect(explorer(origin, target.href).state()).toMatchObject({ path: 'Films/Été 2026/A & B #1', query: '', offset: 0 });
    expect(explorer(origin, shared).state()).toMatchObject({ path: 'Films/Été 2026', query: 'version longue', offset: 50 });
    expect(explorer(target.href).state()).toMatchObject({ path: 'Films/Été 2026/A & B #1', query: '', offset: 0 });
  });

  it('switches spaces at the root and preserves the chosen sort', () => {
    const files = explorer(shared);
    files.switchSpace('downloads');
    expect(Object.fromEntries(files.goto.mock.calls[0][0].searchParams)).toEqual({ space: 'downloads', sort: 'size' });
  });

  it('updates search without losing the folder or sort and replaces subsequent typing in history', () => {
    const files = explorer(shared);
    files.browse({ search: 'A&B + été', offset: '' }, true);
    const [target, options] = files.goto.mock.calls[0];
    expect(Object.fromEntries(target.searchParams)).toEqual({ space: 'share', path: 'Films/Été 2026', search: 'A&B + été', sort: 'size' });
    expect(options).toMatchObject({ replace: true });
    files.browse({ search: 'version longue', offset: '50' });
    expect(files.goto).toHaveBeenCalledTimes(1);
  });

  it.each(['-50', 'Infinity', 'NaN', '1.5', '9007199254740992'])('ignores invalid pagination offset %s', (offset) => {
    expect(explorer(`${origin}?offset=${offset}`).state().offset).toBe(0);
  });

  it('keeps the latest listing when an older request finishes later', async () => {
    let resolveFirst!: (value: unknown) => void;
    const api = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce({ entries: [{ name: 'new file' }], total: 1 });
    const files = explorer(origin, undefined, api);
    const first = files.loadFiles();
    await files.loadFiles();
    resolveFirst({ entries: [{ name: 'old file' }], total: 1 });
    await first;
    expect(files.state()).toMatchObject({ entries: [{ name: 'new file' }], loading: false, error: '' });
  });
});
