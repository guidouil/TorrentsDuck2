import { describe, expect, it } from 'vitest';
import { MAX_BANDWIDTH, megabits, diskPercent, chartPoints } from '../src/lib/transfer-metrics';

describe('transfer card readings', () => {
  it('converts bytes per second to decimal megabits without capping the reading', () => {
    expect(MAX_BANDWIDTH).toBe(200);
    expect(megabits(0)).toBe(0);
    expect(megabits(25_000_000)).toBe(200);
    expect(megabits(30_000_000)).toBe(240);
    expect(megabits(-1)).toBeNull();
    expect(megabits(NaN)).toBeNull();
    expect(megabits(Infinity)).toBeNull();
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

  it('keeps the trace within its viewport even above the bandwidth ceiling', () => {
    expect(chartPoints([], MAX_BANDWIDTH)).toBe('');
    expect(chartPoints([200], MAX_BANDWIDTH)).toBe('240,2');
    expect(chartPoints([-10, 0, 100, 200, 300], MAX_BANDWIDTH)).toBe('0,32 60,32 120,17 180,2 240,2');
  });
});
