/**
 * #900: the Promotion lifecycle, and the one rule that decides when a Promotion
 * has **expired**.
 *
 * `inactive` and `expired` are different states and the ticket is explicit
 * about why: `inactive` is an administrative decision (somebody switched the
 * Promotion off), `expired` is the calendar catching up with a Promotion that
 * was left on. So the sweep only ever moves a Promotion *out of the statuses
 * that can expire naturally* — `EXPIRABLE_STATUSES`, which is `active` alone —
 * and an `inactive` Promotion whose `ends_at` has passed stays `inactive` for
 * ever (§5).
 *
 * **The end-date rule is the one already in force elsewhere**, not a new
 * convention: `validatePromotionSelection()` / `applyPromotionToMembership()`
 * (`api/src/api/membership-promotions.ts`) refuse a Promotion whose
 * `ends_at < now`, comparing the stored DATETIME against the database's own UTC
 * clock. `expired` therefore means exactly "no longer applicable", which is the
 * point of showing it: before this ticket the list said *Active* about a
 * Promotion every apply path already rejected. Anything that changes one side
 * of that pair has to change the other.
 *
 * Why the rule is SQL rather than a predicate: the sweep is one `UPDATE` over
 * every gym's Promotions (a system-wide job, like the nightly runs), so
 * re-deciding it row by row in TypeScript would mean reading the table into the
 * API to write it back. It is spelled once here, with `promotions` aliased by
 * the caller, so the status list above and the clause below cannot drift apart
 * — and so the clause is assertable without a database
 * (`api/src/test/promotion-lifecycle.unit.test.ts`).
 */

/**
 * `promotions.lifecycle_status` (migration 093, widened by migration 202).
 *
 * A new value goes in **two** places: this union — with `LIFECYCLE_STATUSES`
 * below if the API may accept it — and the `chk_promotions_lifecycle_status`
 * CHECK (current definition: migration 202). Adding only the first makes every
 * write of that status fail at the database.
 */
export type PromotionLifecycleStatus = 'active' | 'inactive' | 'expired' | 'deleted';

/**
 * The statuses a client may filter by and write.
 *
 * `deleted` is deliberately absent: it is reached only through
 * `DELETE /promotions/:id` (soft delete) and restored only through the Recycle
 * Bin, and every read already excludes it. `expired` *is* here — not because a
 * gym is expected to pick it by hand (the editor offers Active and Inactive),
 * but because `PUT /promotions/:id` is a partial update whose body carries the
 * status back unchanged: refusing the value a row already holds would make an
 * expired Promotion un-editable.
 */
export const PROMOTION_LIFECYCLE_STATUSES: readonly PromotionLifecycleStatus[] = [
  'active', 'inactive', 'expired',
];

/**
 * The statuses that can expire on their own (§4, §5). Only `active`: an
 * `inactive` Promotion was switched off deliberately, a `deleted` one is in the
 * Recycle Bin, and an `expired` one is already there — which is also what makes
 * the sweep idempotent (§2), since its `UPDATE` matches no row the second time.
 */
export const EXPIRABLE_STATUSES: readonly PromotionLifecycleStatus[] = ['active'];

/**
 * The `WHERE` clause naming every Promotion that should now be `expired`, for
 * the rows of `promotions` aliased as `alias`.
 *
 * `alias` is a code-level SQL identifier, never request input. The clause takes
 * no parameters: the comparison is `ends_at < UTC_TIMESTAMP()`, evaluated by
 * the database, so no DATETIME crosses a timezone conversion on the way in or
 * out (the same reason #785 compares `last_failed_at` in SQL).
 *
 * `ends_at IS NOT NULL` is §6 — "Promotions without an End Date must never be
 * automatically expired". The column is NOT NULL today (migration 019), so the
 * clause is stating the rule rather than filtering anything; it is what keeps
 * the sweep correct if the column is ever relaxed.
 */
export function promotionExpiryWhereSql(alias: string): string {
  const statuses = EXPIRABLE_STATUSES.map((s) => `'${s}'`).join(', ');
  return `${alias}.lifecycle_status IN (${statuses})
      AND ${alias}.ends_at IS NOT NULL
      AND ${alias}.ends_at < UTC_TIMESTAMP()`;
}
