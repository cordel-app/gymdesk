/**
 * #3278 — the application the current request came through, carried with the request's async
 * context so the one writer of `purchases` (`createPurchase()`) can stamp it without every route
 * passing it down. Set only by `tenantContext` (the authenticated tenant routes); a nightly run, a
 * webhook or a script runs outside it and reads `null`.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { PurchaseChannel } from '../domain/purchaseChannel';

const storage = new AsyncLocalStorage<PurchaseChannel>();

/** Runs `fn` (and everything it awaits) as a request of `channel`. */
export function runInRequestChannel<T>(channel: PurchaseChannel, fn: () => T): T {
  return storage.run(channel, fn);
}

/** The current request's channel, or null outside an authenticated tenant request. */
export function currentRequestChannel(): PurchaseChannel | null {
  return storage.getStore() ?? null;
}
