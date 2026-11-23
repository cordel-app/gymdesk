/**
 * #3251 stage 2 — plan snapshots, recurring lines and Billing Events record their cart.
 *
 * Stage 1 (migration 465) linked a Product Set and its one-time lines to the purchase (`purchases`,
 * one row per cart). This migration adds `purchase_id` to the rows a cart writes but does not hold:
 *
 *   - `plan_snapshots` and `product_periodical_snapshots`: the cart a plan or a recurring line was
 *     written in (`stampSnapshotPurchase()`, `api/purchases.ts`). A snapshot a later set links
 *     unchanged keeps its original purchase; a copy made in a cart takes that cart; any other copy
 *     (a lifecycle copy, a bridge edit or reprice) keeps its source's;
 *   - `billing_events`: the checkout an event charged — a Product Set's initial event, a cart
 *     checkout's event, a one-time purchase's event. Scheduled obligations, adjustments and card
 *     verifications are no checkout and stay NULL.
 *
 * Nullable, FK ON DELETE SET NULL like stage 1's: deletion goes through the application's own
 * functions (a cart is deleted only when it is unconfirmed and empty, so no event of a completed
 * checkout ever loses it).
 *
 * Backfill: only what an open cart wrote, as stage 1 did — the plan snapshots and recurring lines an
 * `in_cart` / `pending_payment` set with a purchase links and no other set links, the initial events
 * of those sets and the events of the one-time lines that already carry a purchase. History stays NULL.
 */

const TABLES = ['plan_snapshots', 'product_periodical_snapshots', 'billing_events'];

exports.up = async (knex) => {
  for (const table of TABLES) {
    if (await knex.schema.hasColumn(table, 'purchase_id')) continue;
    await knex.raw(`ALTER TABLE ${table} ADD COLUMN purchase_id INT UNSIGNED NULL,
      ADD KEY idx_${table}_purchase (purchase_id),
      ADD CONSTRAINT fk_${table}_purchase FOREIGN KEY (purchase_id) REFERENCES purchases (id) ON DELETE SET NULL`);
  }

  for (const [table, junction, col] of [
    ['plan_snapshots', 'product_set_plan_snapshots', 'plan_snapshot_id'],
    ['product_periodical_snapshots', 'product_set_periodical_snapshots', 'product_periodical_snapshot_id'],
  ]) {
    await knex.raw(
      `UPDATE ${table} s
         JOIN ${junction} j ON j.${col} = s.id
         JOIN product_sets ps ON ps.id = j.product_set_id
          SET s.purchase_id = ps.purchase_id
        WHERE s.purchase_id IS NULL AND ps.purchase_id IS NOT NULL
          AND ps.status IN ('in_cart','pending_payment')
          AND NOT EXISTS (SELECT 1 FROM ${junction} o WHERE o.${col} = s.id AND o.product_set_id <> j.product_set_id)`);
  }

  await knex.raw(
    `UPDATE billing_events be
       JOIN product_sets ps ON ps.id = be.product_set_id
        SET be.purchase_id = ps.purchase_id
      WHERE be.purchase_id IS NULL AND ps.purchase_id IS NOT NULL
        AND ps.status IN ('in_cart','pending_payment')
        AND be.event_type = 'payment_recorded' AND be.is_scheduled = 0`);
  for (const [table, junction, col] of [
    ['product_oneoff_snapshots', 'billing_event_oneoff_snapshots', 'product_oneoff_snapshot_id'],
    ['product_session_snapshots', 'billing_event_session_snapshots', 'product_session_snapshot_id'],
  ]) {
    await knex.raw(
      `UPDATE billing_events be
         JOIN ${junction} j ON j.billing_event_id = be.id
         JOIN ${table} s ON s.id = j.${col}
          SET be.purchase_id = s.purchase_id
        WHERE be.purchase_id IS NULL AND s.purchase_id IS NOT NULL`);
  }
};

exports.down = async (knex) => {
  for (const table of TABLES) {
    if (!(await knex.schema.hasColumn(table, 'purchase_id'))) continue;
    await knex.raw(`ALTER TABLE ${table} DROP FOREIGN KEY fk_${table}_purchase`);
    await knex.raw(`ALTER TABLE ${table} DROP KEY idx_${table}_purchase, DROP COLUMN purchase_id`);
  }
};
