import { describe, expect, it, vi } from 'vitest';
import { clerkUserCacheTtlMs, createCachedLookup } from '../infra/clerkUserCache';

describe('createCachedLookup', () => {
  it('is a pass-through at ttl 0', async () => {
    const fetcher = vi.fn(async (id: string) => ({ id }));
    const lookup = createCachedLookup(fetcher, { ttlMs: 0 });
    await lookup('u1');
    await lookup('u1');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('answers a repeat within the ttl without calling Clerk, and again after it', async () => {
    let t = 1000;
    const fetcher = vi.fn(async (id: string) => ({ id }));
    const lookup = createCachedLookup(fetcher, { ttlMs: 60_000, now: () => t });
    await lookup('u1');
    t += 59_000;
    await lookup('u1');
    expect(fetcher).toHaveBeenCalledTimes(1);
    t += 2_000;
    await lookup('u1');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('shares one request between concurrent callers for the same id', async () => {
    const fetcher = vi.fn(async (id: string) => ({ id }));
    const lookup = createCachedLookup(fetcher, { ttlMs: 60_000 });
    await Promise.all([lookup('u1'), lookup('u1'), lookup('u1'), lookup('u2')]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('never remembers a failure', async () => {
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new Error('Too Many Requests'))
      .mockResolvedValueOnce({ id: 'u1' });
    const lookup = createCachedLookup(fetcher, { ttlMs: 60_000 });
    await expect(lookup('u1')).rejects.toThrow('Too Many Requests');
    await expect(lookup('u1')).resolves.toEqual({ id: 'u1' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('is bounded', async () => {
    const fetcher = vi.fn(async (id: string) => ({ id }));
    const lookup = createCachedLookup(fetcher, { ttlMs: 60_000, maxEntries: 2 });
    await lookup('a'); await lookup('b'); await lookup('c');
    await lookup('a'); // evicted, fetched again
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
});

describe('clerkUserCacheTtlMs', () => {
  it('defaults to 60 s, 0 under test, and honours the variable', () => {
    expect(clerkUserCacheTtlMs({} as NodeJS.ProcessEnv)).toBe(60_000);
    expect(clerkUserCacheTtlMs({ NODE_ENV: 'test' } as NodeJS.ProcessEnv)).toBe(0);
    expect(clerkUserCacheTtlMs({ CLERK_USER_CACHE_TTL_SECONDS: '15' } as NodeJS.ProcessEnv)).toBe(15_000);
    expect(clerkUserCacheTtlMs({ CLERK_USER_CACHE_TTL_SECONDS: '0' } as NodeJS.ProcessEnv)).toBe(0);
    expect(clerkUserCacheTtlMs({ CLERK_USER_CACHE_TTL_SECONDS: 'abc' } as NodeJS.ProcessEnv)).toBe(60_000);
  });
});
