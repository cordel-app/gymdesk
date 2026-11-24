/**
 * #3307 stage 2 — when Admin → Member → Products stops showing a paid cart (pure).
 *
 * After Save & Pay a cart that becomes `completed` (paid in cash or by card, settled by the provider,
 * or activated because nothing was owed) stays in the Products view's Summary for
 * `PAID_CART_VISIBLE_MINUTES` after it was completed (`purchases.completed_at`, migration 480), or
 * until the owner opens a newer cart, whichever comes first. Both are read from persisted rows, never
 * a client timer: a reload inside the hour still shows it, a reload after it does not.
 */
export const PAID_CART_VISIBLE_MINUTES = 60;

/**
 * The predicate on a `purchases` row aliased `alias` that makes it the owner's visible paid cart:
 * completed within the window and no purchase of the same owner created after it. Compared in SQL
 * against `UTC_TIMESTAMP()`, so no DATETIME crosses a timezone conversion.
 */
export function visiblePaidCartSql(alias: string): string {
  return `${alias}.status = 'completed' AND ${alias}.completed_at IS NOT NULL
      AND ${alias}.completed_at > UTC_TIMESTAMP() - INTERVAL ${PAID_CART_VISIBLE_MINUTES} MINUTE
      AND NOT EXISTS (SELECT 1 FROM purchases newer
                       WHERE newer.gym_id = ${alias}.gym_id AND newer.owner_member_id = ${alias}.owner_member_id
                         AND newer.id > ${alias}.id)`;
}

/** Whether a cart completed at `completedAt` is still inside the window at `now` (the SQL's rule, for a test or a caller with the row). */
export function paidCartStillVisible(completedAt: Date | null, now: Date, hasNewerCart: boolean): boolean {
  if (!completedAt || hasNewerCart) return false;
  return now.getTime() - completedAt.getTime() < PAID_CART_VISIBLE_MINUTES * 60_000;
}
