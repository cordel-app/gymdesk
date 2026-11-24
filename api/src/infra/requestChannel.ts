/**
 * #3278 — the application the current request came through, carried with the request's async
 * context so the one writer of `purchases` (`createPurchase()`) can stamp it without every route
 * passing it down. Set only by `tenantContext` (the authenticated tenant routes); a nightly run, a
 * webhook or a script runs outside it and reads `null`.
 *
 * #3288 — the same context carries the request's locale (`getRequestLocale()`, the allowlisted
 * `x-locale` / `Accept-Language`), the language a new Purchase's canonical name is written in.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { PurchaseChannel } from '../domain/purchaseChannel';

interface RequestContext { channel: PurchaseChannel; locale: string | null }

const storage = new AsyncLocalStorage<RequestContext>();

/** Runs `fn` (and everything it awaits) as a request of `channel`, in `locale` when known. */
export function runInRequestChannel<T>(channel: PurchaseChannel, fn: () => T, locale: string | null = null): T {
  return storage.run({ channel, locale }, fn);
}

/** The current request's channel, or null outside an authenticated tenant request. */
export function currentRequestChannel(): PurchaseChannel | null {
  return storage.getStore()?.channel ?? null;
}

/** #3288: the current request's locale, or null outside an authenticated tenant request. */
export function currentRequestLocale(): string | null {
  return storage.getStore()?.locale ?? null;
}
