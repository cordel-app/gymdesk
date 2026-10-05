/**
 * *Why* a storage-backed save failed, for the browser (#1042).
 *
 * The mirror of `api/src/domain/storageFailureCause.ts`: that module is where
 * the vocabulary is declared and where the API diagnoses its own failures, and
 * this one is where the admin diagnoses the failures that never reach a route —
 * a 401 from the proxy, a 404 from the router before it touched storage — from
 * their HTTP status. A new cause goes in **three** places: that declaration,
 * this mirror, and a `storage_cause_<value>` + `storage_suggestion_<value>` pair
 * in both theme namespaces of `apps/admin/locales/base/{en,es,ca}.json`, because
 * the key is interpolated from the wire value and next-intl prints a missing key
 * verbatim.
 *
 * Two of its answers are the rule rather than the implementation.
 *
 * **The API's own word wins.** A 409 is `not_initialized` when the route said
 * so and nothing at all when it did not — 409 is also *a theme with this name
 * already exists*, and a status-derived guess would tell an administrator to
 * initialize a bucket over a duplicate name. The same holds for 400, which is a
 * rejected file on an upload route and a rejected status value on the settings
 * `PUT`; only the route knows which.
 *
 * **An undiagnosed failure says nothing.** `storageFailureCause()` answers
 * `null` rather than an `unknown` member, and the formatter then renders the
 * block exactly as it did before this ticket — operation, path, error, details,
 * with no invented *Why* and, above all, no `Initialize bucket` button. That is
 * §4 ("do not incorrectly suggest bucket initialization unless the error
 * indicates that initialization is the problem") holding by construction.
 */

import type { StorageErrorLike } from '@/lib/storageErrorMessage';

export const STORAGE_FAILURE_CAUSES = [
  'not_configured',
  'not_initialized',
  'not_found',
  'access_denied',
  'invalid_file',
  'unreachable',
] as const;

export type StorageFailureCause = (typeof STORAGE_FAILURE_CAUSES)[number];

export function isStorageFailureCause(value: unknown): value is StorageFailureCause {
  return typeof value === 'string' && (STORAGE_FAILURE_CAUSES as readonly string[]).includes(value);
}

/** The one rule for which cause may offer Initialize — §3/§4. */
export function storageCauseSuggestsInitialize(cause: StorageFailureCause | null): boolean {
  return cause === 'not_initialized';
}

/**
 * Statuses the admin may diagnose on its own, because they mean the same thing
 * whichever route answered them. 409 and 400 are deliberately absent: both are
 * ambiguous without the route's own `cause`.
 */
const CAUSE_BY_STATUS: Record<number, StorageFailureCause> = {
  401: 'access_denied',
  403: 'access_denied',
  404: 'not_found',
  413: 'invalid_file',
  415: 'invalid_file',
  502: 'unreachable',
  503: 'unreachable',
  504: 'unreachable',
};

export function storageFailureCause(err: StorageErrorLike | null | undefined): StorageFailureCause | null {
  const reported = err?.body?.cause;
  if (isStorageFailureCause(reported)) return reported;
  const status = err?.status ?? null;
  return (status !== null && CAUSE_BY_STATUS[status]) || null;
}
