import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transpile } from 'typescript';
import { describe, expect, it } from 'vitest';
import { bytes } from '../src/lib/client';
import { transferSpeed, diskPercent, chartPoints } from '../src/lib/transfer-metrics';

function gaugeReading(value: number | null, maximum: number, unit = 'o/s') {
  const script = readFileSync(new URL('../src/lib/MetricGauge.svelte', import.meta.url), 'utf8').split('<script lang="ts">')[1].split('</script>')[0].replace(/^\s*import .+;\s*$/gm, '');
  const context: Record<string, any> = { bytes, $language: 'fr-FR', $props: () => ({ value, maximum, unit, label: 'Transfer' }), $derived: (value: unknown) => value };
  runInNewContext(transpile(`${script}\nglobalThis.reading = { formatted, displayedUnit, formattedMaximum, percent };`), context);
  return context.reading;
}

describe('transfer card readings', () => {
  it('keeps valid transfer speeds in native bytes per second without capping them', () => {
    expect(transferSpeed(0)).toBe(0);
    expect(transferSpeed(25_000_000)).toBe(25_000_000);
    expect(transferSpeed(30_000_000)).toBe(30_000_000);
    expect(transferSpeed(-1)).toBeNull();
    expect(transferSpeed(NaN)).toBeNull();
    expect(transferSpeed(Infinity)).toBeNull();
  });

  it.each([
    [512, '512', 'o/s'],
    [1024, '1', 'Kio/s'],
    [1.5 * 1024 ** 2, '1,5', 'Mio/s']
  ] as const)('formats %s bytes/s with its matching binary unit', (value, formatted, displayedUnit) => {
    expect(gaugeReading(value, 2 * 1024 ** 2)).toMatchObject({ formatted, displayedUnit, formattedMaximum: '2 Mio/s' });
  });

  it('keeps zero and unknown readings safe before a peak is recorded', () => {
    expect(gaugeReading(0, 0)).toEqual({ formatted: '0', displayedUnit: 'o/s', formattedMaximum: '0 o/s', percent: 0 });
    expect(gaugeReading(null, 0)).toEqual({ formatted: '—', displayedUnit: 'o/s', formattedMaximum: '0 o/s', percent: 0 });
  });

  it('preserves the percentage display used for disk space', () => {
    expect(gaugeReading(30, 100, '%')).toEqual({ formatted: '30', displayedUnit: '%', formattedMaximum: '100 %', percent: 30 });
  });

  it('uses real used space when provided and falls back to available space', () => {
    expect(diskPercent({ total: 100, used: 30, available: 60 })).toBe(30);
    expect(diskPercent({ total: 100, available: 60 })).toBe(40);
    expect(diskPercent({ total: 100, used: 0 })).toBe(0);
    expect(diskPercent({ total: 100, used: 150 })).toBe(100);
    for (const storage of [{}, { total: 0, used: 0 }, { total: -1, used: 1 }, { total: Infinity, used: 1 }, { total: 100 }, { total: 100, used: NaN }, { total: 100, available: Infinity }]) {
      expect(diskPercent(storage)).toBeNull();
    }
  });

  it('scales the trace to the observed bandwidth peak and keeps it within its viewport', () => {
    expect(chartPoints([], 500)).toBe('');
    expect(chartPoints([500], 500)).toBe('240,2');
    expect(chartPoints([-10, 0, 250, 500, 750], 500)).toBe('0,32 60,32 120,17 180,2 240,2');
  });

  it('keeps an idle trace flat before any bandwidth peak has been observed', () => {
    expect(chartPoints([], 0)).toBe('');
    expect(chartPoints([0], 0)).toBe('240,32');
    expect(chartPoints([0, 0], 0)).toBe('0,32 240,32');
  });
});
