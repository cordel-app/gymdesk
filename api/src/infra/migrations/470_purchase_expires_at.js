/**
 * #3274 — the two-hour In-Cart expiry belongs to the purchase (#3251's cart), not to what it holds.
 *
 * Until now one cart had two clocks: a Product Set Draft expired two hours after its
 * `product_sets.last_activity_at` (#1325) and a standalone one-time Product two hours after its own
 * `created_at` (#2962). A cart holding both therefore expired piece by piece. `purchases.expires_at`
 * is now the one record: set two hours ahead when a cart is opened or returns to the cart, moved two
 * hours ahead by every change of its contents, and NULL whenever the purchase is not `in_cart`
 * (a Pending Payment keeps #1991's own timeout; a completed or cancelled purchase has no cart clock).
 *
 * Backfill: an `in_cart` purchase takes the latest of its own creation, its in-cart Product Sets'
 * `last_activity_at` and its in-cart one-time lines' `created_at`, plus two hours — the clock that
 * expired last under the old rules, so no item of a mixed cart expires earlier than it would have.
 * Every other purchase keeps NULL. Idempotent: only NULL values of `in_cart` rows are filled.
 *
 * A cart an API image still running the previous code opens while this deploys has no clock; the new
 * code reads a NULL clock as two hours after the cart's creation (`cartClockSql()`), so it is neither
 * expired at once nor kept for ever. A cart whose items were all idle for more than two hours gets a
 * clock already past, and the first expiry sweep after the deploy deletes it, as the old rules would
 * have. The 120 minutes mirror `CART_TTL_MINUTES` (`domain/cartExpiry.ts`), frozen here.
 *
 * `down` drops the index and the column.
 */

exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('purchases', 'expires_at'))) {
    await knex.raw(`ALTER TABLE purchases ADD COLUMN expires_at DATETIME NULL AFTER status,
      ADD KEY idx_purchases_status_expires (status, expires_at)`);
  }
  await knex.raw(`
    UPDATE purchases p
       SET p.expires_at = GREATEST(
             p.created_at,
             COALESCE((SELECT MAX(ps.last_activity_at) FROM product_sets ps
                        WHERE ps.purchase_id = p.id AND ps.status = 'in_cart'), p.created_at),
             COALESCE((SELECT MAX(s.created_at) FROM product_session_snapshots s
                        WHERE s.purchase_id = p.id AND s.status = 'in_cart'), p.created_at),
             COALESCE((SELECT MAX(o.created_at) FROM product_oneoff_snapshots o
                        WHERE o.purchase_id = p.id AND o.status = 'in_cart'), p.created_at)
           ) + INTERVAL 120 MINUTE
     WHERE p.status = 'in_cart' AND p.expires_at IS NULL`);
};

exports.down = async (knex) => {
  if (await knex.schema.hasColumn('purchases', 'expires_at')) {
    await knex.raw('ALTER TABLE purchases DROP KEY idx_purchases_status_expires, DROP COLUMN expires_at');
  }
};
