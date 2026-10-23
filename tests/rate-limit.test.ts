import { describe, expect, it, vi } from 'vitest';
import { rateLimit } from '../src/lib/server/rate-limit';

describe('login rate limiting', () => {
  it('rejects excess requests and permits retries after expiry', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000);
    rateLimit('test-login', 2, 100);
    rateLimit('test-login', 2, 100);
    expect(() => rateLimit('test-login', 2, 100)).toThrow();
    vi.mocked(Date.now).mockReturnValue(1101);
    expect(() => rateLimit('test-login', 2, 100)).not.toThrow();
    vi.restoreAllMocks();
  });
});
