import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transpile } from 'typescript';
import { describe, expect, it, vi } from 'vitest';

function mountTransfers(api = vi.fn().mockResolvedValue({ torrents: [] })) {
  const script = readFileSync(new URL('../src/routes/(app)/+page.svelte', import.meta.url), 'utf8').split('<script lang="ts">')[1].split('</script>')[0].replace(/^\s*import .+;\s*$/gm, '');
  const context: Record<string, any> = {
    api, FormData, $t: { torrentAdded: 'Added' }, onMount: () => {},
    $props: () => ({ data: { user: { id: 'member' } } }),
    $state: (value: unknown) => value, $derived: (value: unknown) => value
  };
  runInNewContext(transpile(`${script}\nglobalThis.transfers = { addTorrent, input: (value, file) => { source = value; upload = file; }, state: () => ({ source, upload, busy, error, notice }) };`), context);
  const reset = vi.fn();
  return { api, reset, event: { preventDefault: vi.fn(), currentTarget: { reset } }, ...context.transfers };
}

describe('inline torrent form', () => {
  it.each(['', ' \n\t '])('ignores an empty source %j', async (source) => {
    const transfers = mountTransfers();
    transfers.input(source);
    await transfers.addTorrent(transfers.event);
    expect(transfers.api).not.toHaveBeenCalled();
    expect(transfers.reset).not.toHaveBeenCalled();
    expect(transfers.state()).toMatchObject({ source, busy: false, error: '', notice: '' });
  });

  it('ignores a second submission while the first upload is pending', async () => {
    let complete!: () => void;
    const api = vi.fn().mockImplementationOnce(() => new Promise<void>((resolve) => { complete = resolve; })).mockResolvedValue({ torrents: [] });
    const transfers = mountTransfers(api);
    transfers.input('magnet:?xt=urn:btih:0123456789012345678901234567890123456789');
    const pending = transfers.addTorrent(transfers.event);
    await transfers.addTorrent(transfers.event);
    expect(api).toHaveBeenCalledOnce();
    expect(transfers.state().busy).toBe(true);
    complete();
    await pending;
    expect(api.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
    expect(transfers.reset).toHaveBeenCalledOnce();
    expect(transfers.state().busy).toBe(false);
  });

  it('clears a successful file submission so another file or link can follow', async () => {
    const transfers = mountTransfers();
    const file = new File(['de'], 'first.torrent');
    transfers.input('', file);
    await transfers.addTorrent(transfers.event);
    expect(transfers.api.mock.calls[0][1].body.get('torrent').name).toBe('first.torrent');
    expect(transfers.reset).toHaveBeenCalledOnce();
    expect(transfers.state()).toMatchObject({ source: '', upload: undefined, busy: false, notice: 'Added' });

    transfers.input('magnet:?xt=urn:btih:0123456789012345678901234567890123456789');
    await transfers.addTorrent(transfers.event);
    expect(transfers.api.mock.calls[2][1].body.get('source')).toBe('magnet:?xt=urn:btih:0123456789012345678901234567890123456789');
    expect(transfers.reset).toHaveBeenCalledTimes(2);
  });

  it('keeps a rejected source available for correction or retry', async () => {
    const transfers = mountTransfers(vi.fn().mockRejectedValue(new Error('Invalid torrent')));
    transfers.input('magnet:invalid');
    await transfers.addTorrent(transfers.event);
    expect(transfers.reset).not.toHaveBeenCalled();
    expect(transfers.state()).toMatchObject({ source: 'magnet:invalid', busy: false, error: 'Invalid torrent', notice: '' });
  });

  it('keeps a rejected file available for a successful retry', async () => {
    const transfers = mountTransfers(vi.fn().mockRejectedValueOnce(new Error('Upload failed')).mockResolvedValue({ torrents: [] }));
    const file = new File(['de'], 'retry.torrent');
    transfers.input('', file);
    await transfers.addTorrent(transfers.event);
    expect(transfers.reset).not.toHaveBeenCalled();
    expect(transfers.state().upload).toBe(file);
    expect(transfers.state()).toMatchObject({ source: '', busy: false, error: 'Upload failed', notice: '' });

    await transfers.addTorrent(transfers.event);
    expect(transfers.api.mock.calls[1][1].body.get('torrent').name).toBe('retry.torrent');
    expect(transfers.reset).toHaveBeenCalledOnce();
    expect(transfers.state()).toMatchObject({ source: '', upload: undefined, busy: false, error: '', notice: 'Added' });
  });
});
