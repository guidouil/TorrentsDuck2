import { error } from '@sveltejs/kit';

const buckets = new Map<string, { count: number; expires: number }>();

// shortcut: in-memory limits target one app process; use shared storage before adding replicas.
export function rateLimit(key: string, maximum = 10, windowMs = 60_000): void {
  const now = Date.now();
  if (buckets.size > 10_000) {
    for (const [name, bucket] of buckets) if (bucket.expires <= now) buckets.delete(name);
    if (buckets.size > 10_000) error(429, 'Too many requests');
  }
  let bucket = buckets.get(key);
  if (!bucket || bucket.expires <= now) {
    bucket = { count: 0, expires: now + windowMs };
    buckets.set(key, bucket);
  }
  if (++bucket.count > maximum) error(429, 'Too many requests');
}
