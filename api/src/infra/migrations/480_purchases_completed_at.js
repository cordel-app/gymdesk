/**
 * #3307 stage 2 — `purchases.completed_at`: when a cart (#3251) became `completed` (paid, or
 * activated because nothing was owed).
 *
 * Admin → Member → Products keeps a paid cart visible for one hour after it is paid, or until a
 * newer cart is opened (`domain/paidCartVisibility.ts`). That window needs the moment the cart was
 * paid, persisted rather than remembered by the page. `syncPurchase()` (`api/src/api/purchases.ts`)
 * is the only writer: it stamps the column when the cart enters `completed` and clears it when the
 * cart leaves it.
 *
 * Backfill: a cart already `completed` takes its `modified_at` (the last status write, which is the
 * completion) else its `created_at`. Only the one-hour window reads it, so an approximate value on a
 * historical row hides it a little earlier or later than exact, and nothing else changes.
 * Re-runnable: only NULL values of completed carts are filled.
 */
exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('purchases', 'completed_at'))) {
    await knex.raw('ALTER TABLE purchases ADD COLUMN completed_at DATETIME NULL AFTER status');
  }
  await knex.raw(
    `UPDATE purchases SET completed_at = COALESCE(modified_at, created_at)
      WHERE status = 'completed' AND completed_at IS NULL`);
};

exports.down = async (knex) => {
  if (await knex.schema.hasColumn('purchases', 'completed_at')) {
    await knex.raw('ALTER TABLE purchases DROP COLUMN completed_at');
  }
};
