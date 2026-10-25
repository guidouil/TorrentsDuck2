import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transpile } from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { transferSpeed, diskPercent, chartPoints } from '../src/lib/transfer-metrics';

function mountTransfers(api = vi.fn().mockResolvedValue({ torrents: [] })) {
  let mount = () => () => {};
  const script = readFileSync(new URL('../src/routes/(app)/+page.svelte', import.meta.url), 'utf8').split('<script lang="ts">')[1].split('</script>')[0].replace(/^\s*import .+;\s*$/gm, '');
  const context: Record<string, any> = {
    api, FormData, $t: { torrentAdded: 'Added' }, onMount: (callback: () => () => void) => { mount = callback; },
    EventSource: class { addEventListener() {} close() {} },
    transferSpeed, diskPercent, chartPoints,
    $props: () => ({ data: { user: { id: 'member' } } }),
    $state: (value: unknown) => value, $derived: (value: unknown) => value
  };
  runInNewContext(transpile(`${script}\nglobalThis.transfers = { addTorrent, snapshot, input: (value, file) => { source = value; upload = file; }, state: () => ({ source, upload, busy, error, notice, history, lastSample, stats, peaks }) };`), context);
  const reset = vi.fn();
  return { api, reset, mount: () => mount(), event: { preventDefault: vi.fn(), currentTarget: { reset } }, ...context.transfers };
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

describe('live transfer chart', () => {
  it('uses shared server peaks independently from the current transfer speeds', () => {
    const transfers = mountTransfers();
    transfers.snapshot({ sampledAt: 1, stats: { downloadSpeed: 50_000_000, uploadSpeed: 2_000_000, downloadPeak: 62_500_000, uploadPeak: 10_000_000 } });
    expect(transfers.state().peaks).toEqual({ download: 62_500_000, upload: 10_000_000 });
    transfers.snapshot({ sampledAt: 2, stats: { downloadSpeed: 0, uploadSpeed: 0, downloadPeak: 75_000_000, uploadPeak: 25_000_000 } });
    expect(transfers.state().peaks).toEqual({ download: 75_000_000, upload: 25_000_000 });
    for (let sampledAt = 3; sampledAt <= 45; sampledAt++) {
      transfers.snapshot({ sampledAt, stats: { downloadSpeed: 0, uploadSpeed: 0, downloadPeak: 75_000_000, uploadPeak: 25_000_000 } });
    }
    expect(transfers.state().history).toHaveLength(40);
    expect(transfers.state().peaks).toEqual({ download: 75_000_000, upload: 25_000_000 });
  });

  it('receives the same recorded peaks when another browser opens the page', async () => {
    const sample = { sampledAt: 1, stats: { downloadSpeed: 1_000_000, uploadSpeed: 0, downloadPeak: 62_500_000, uploadPeak: 10_000_000 } };
    const api = vi.fn().mockResolvedValue(sample);
    const first = mountTransfers(api);
    const second = mountTransfers(api);
    first.mount();
    second.mount();
    await Promise.resolve();
    expect(api).toHaveBeenCalledTimes(2);
    expect(first.state().peaks).toEqual({ download: 62_500_000, upload: 10_000_000 });
    expect(second.state().peaks).toEqual(first.state().peaks);
  });

  it('uses zero for missing or invalid server peaks without inferring them from current traffic', () => {
    const transfers = mountTransfers();
    transfers.snapshot({ sampledAt: 1, stats: { downloadSpeed: 62_500_000, uploadSpeed: 10_000_000 } });
    expect(transfers.state().peaks).toEqual({ download: 0, upload: 0 });
    transfers.snapshot({ sampledAt: 2, stats: { downloadSpeed: 0, uploadSpeed: 0, downloadPeak: -1, uploadPeak: Infinity } });
    expect(transfers.state().peaks).toEqual({ download: 0, upload: 0 });
  });

  it('does not duplicate the same cached sample received over HTTP and SSE', () => {
    const transfers = mountTransfers();
    const sample = { sampledAt: 123, stats: { downloadSpeed: 25_000_000, uploadSpeed: 0 } };
    transfers.snapshot(sample);
    transfers.snapshot(sample);
    transfers.snapshot({ ...sample, sampledAt: 122, stats: { downloadSpeed: 0, uploadSpeed: 0 } });
    expect(transfers.state().stats).toEqual(sample.stats);
    expect(transfers.state().history).toEqual([{ download: 25_000_000, upload: 0 }]);
    expect(transfers.state().lastSample).toBe(123);
  });

  it('keeps only the last 40 valid samples, preserving genuine zero speeds', () => {
    const transfers = mountTransfers();
    for (let sampledAt = 1; sampledAt <= 45; sampledAt++) {
      transfers.snapshot({ sampledAt, stats: { downloadSpeed: sampledAt * 1_000_000, uploadSpeed: 0 } });
    }
    expect(transfers.state().history).toHaveLength(40);
    expect(transfers.state().history[0]).toEqual({ download: 6_000_000, upload: 0 });
    expect(transfers.state().history.at(-1)).toEqual({ download: 45_000_000, upload: 0 });
    transfers.snapshot({ sampledAt: 46, stats: { downloadSpeed: NaN, uploadSpeed: 0 } });
    expect(transfers.state().history).toHaveLength(40);
    expect(transfers.state().history.at(-1)).toEqual({ download: 45_000_000, upload: 0 });
  });
});
