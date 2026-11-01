/**
 * #2125 stage 17 — `product_set_plan_snapshots` is gone.
 *
 * It held a ProductSet version's plan configuration, one row per version (`UNIQUE (product_set_id)`),
 * and `plan_snapshots` (migration 347) was derived from it. The plan snapshot is the source of truth
 * for every writer and reader now, and a version holds as many plans as it has snapshots, so the
 * legacy table and the `source_plan_snapshot_id` link to it (with its UNIQUE key) are dropped.
 *
 * Safety. The legacy table is the *older* copy — since stage 5 every reader has used the twin — so
 * the full backfill is deliberately not re-run: it could re-create a plan someone removed from a
 * Draft. The migration only refuses to drop when a version that carries a plan has **no plan
 * snapshot at all**, and reports (without refusing) legacy rows of plan-less versions that hold
 * values. Each step is independent and guarded on its own state, so an interrupted run can be
 * repeated.
 *
 * `down` cannot restore the legacy rows (the configuration lives in `plan_snapshots`): it throws,
 * so a rollback never claims to have undone this.
 */
exports.up = async (knex) => {
  const hasTable = await knex.schema.hasTable('product_set_plan_snapshots');
  const hasColumn = await knex.schema.hasColumn('plan_snapshots', 'source_plan_snapshot_id');

  if (hasTable) {
    const [[orphans]] = await knex.raw(
      `SELECT COUNT(*) AS n FROM product_set_plan_snapshots psps
         JOIN product_sets ps ON ps.id = psps.product_set_id AND ps.gym_id = psps.gym_id
        WHERE ps.membership_plan_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM plan_snapshots s WHERE s.product_set_id = psps.product_set_id)`);
    if (Number(orphans.n) > 0) {
      throw new Error(`migration 356: ${orphans.n} version(s) carry a plan configuration but no plan snapshot; nothing was dropped`);
    }
    const [[valued]] = await knex.raw(
      `SELECT COUNT(*) AS n FROM product_set_plan_snapshots psps
         JOIN product_sets ps ON ps.id = psps.product_set_id AND ps.gym_id = psps.gym_id
        WHERE ps.membership_plan_id IS NULL
          AND (psps.membership_fee_price IS NOT NULL OR psps.discount_reason IS NOT NULL OR psps.plan_price_id IS NOT NULL)`);
    if (Number(valued.n) > 0) {
      console.log(`migration 356: ${valued.n} plan-less version(s) held a priced configuration row; it is not carried over`);
    }
  }

  if (hasColumn) {
    const [keys] = await knex.raw(
      `SELECT 1 FROM information_schema.statistics
        WHERE table_schema = DATABASE() AND table_name = 'plan_snapshots' AND index_name = 'plan_snapshots_source_key' LIMIT 1`);
    if (keys.length > 0) await knex.raw('ALTER TABLE plan_snapshots DROP KEY plan_snapshots_source_key');
    await knex.raw('ALTER TABLE plan_snapshots DROP COLUMN source_plan_snapshot_id');
  }
  if (hasTable) await knex.schema.dropTableIfExists('product_set_plan_snapshots');
};

exports.down = async () => {
  throw new Error('migration 356 cannot be rolled back: the configuration lives in plan_snapshots');
};
