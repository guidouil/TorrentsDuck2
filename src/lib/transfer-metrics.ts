export const MAX_BANDWIDTH = 200;

export function megabits(bytesPerSecond: number): number | null {
  return Number.isFinite(bytesPerSecond) && bytesPerSecond >= 0 ? bytesPerSecond * 8 / 1_000_000 : null;
}

export function diskPercent(storage: { total?: number; used?: number; available?: number }): number | null {
  const { total, available } = storage;
  const used = storage.used ?? (total !== undefined && available !== undefined ? total - available : NaN);
  return total !== undefined && Number.isFinite(total) && total > 0 && Number.isFinite(used)
    ? Math.min(100, Math.max(0, used / total * 100)) : null;
}

export function chartPoints(values: number[], maximum: number): string {
  return values.map((value, index) => `${values.length === 1 ? 240 : index / (values.length - 1) * 240},${32 - Math.min(1, Math.max(0, value / maximum)) * 30}`).join(' ');
}
