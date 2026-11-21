/**
 * #3026 stage 3c-2: a Plan Promotion application states its own confirmation.
 *
 * `plan_promotion_snapshots.snapshot_confirmed_at` is the moment the application's snapshot was
 * taken (Save & Pay or the free commit, #2624 stage 4 / #2833). Until now only the legacy
 * `user_membership_promotions` row carried it, so every reader that had to tell a Draft's
 * reference from a confirmed application joined that table. With the column on the plan snapshot
 * row the readers ask the row itself (`planPromotionReferenceSql()`).
 *
 * Backfill: a row with a legacy twin (`source_id`) takes the twin's value; a row with none (a copy
 * made with its plan snapshot) is confirmed as of its own creation when it holds a snapshot or a
 * committed Product Set links its plan snapshot; a copy of a reference on a snapshot only an In
 * Cart set links stays unconfirmed, so it is still read live and confirmed by Save & Pay. Additive and re-entrant; `down` drops the column.
 */
exports.up = async (knex) => {
  const has = await knex.schema.hasColumn('plan_promotion_snapshots', 'snapshot_confirmed_at');
  if (!has) {
    await knex.schema.alterTable('plan_promotion_snapshots', (t) => {
      t.datetime('snapshot_confirmed_at').nullable();
    });
  }
  await knex.raw(
    `UPDATE plan_promotion_snapshots pps
       JOIN user_membership_promotions ump ON ump.id = pps.source_id
        SET pps.snapshot_confirmed_at = ump.snapshot_confirmed_at
      WHERE pps.snapshot_confirmed_at IS NULL AND ump.snapshot_confirmed_at IS NOT NULL`);
  await knex.raw(
    `UPDATE plan_promotion_snapshots
        SET snapshot_confirmed_at = created_at
      WHERE source_id IS NULL AND snapshot_confirmed_at IS NULL
        AND (snapshot IS NOT NULL OR EXISTS (
              SELECT 1 FROM product_set_plan_snapshots j
                JOIN product_sets ps ON ps.id = j.product_set_id
               WHERE j.plan_snapshot_id = plan_promotion_snapshots.plan_snapshot_id
                 AND ps.status <> 'in_cart'))`);
};

exports.down = async (knex) => {
  const has = await knex.schema.hasColumn('plan_promotion_snapshots', 'snapshot_confirmed_at');
  if (has) {
    await knex.schema.alterTable('plan_promotion_snapshots', (t) => {
      t.dropColumn('snapshot_confirmed_at');
    });
  }
};
