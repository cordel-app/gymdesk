/**
 * #3026 stage 3d-2: the Membership Plan Promotion applications leave `user_membership_promotions`.
 *
 * Since stage 3d-1 a Plan application is its plan snapshot's own row (`plan_promotion_snapshots`)
 * and nothing writes or reads a `user_membership_promotions` row for it. This removes the rows
 * written before that, so the table holds Product-target applications only.
 *
 * Nothing is lost that a reader could reach:
 *   1. a legacy Plan row with no row for its Promotion on its Product Set's primary plan snapshot
 *      (through the snapshot that holds the Promotions) is first written there, keyed by the legacy
 *      id (`source_id`), with its grant rows. `INSERT IGNORE`: the standing key (migration 450) keeps
 *      one standing row per Promotion and snapshot;
 *   2. then every legacy Plan row that is represented (its own twin by `source_id`, or a row for the
 *      same Promotion on that snapshot) is deleted; its legacy grant rows go with it (FK cascade).
 *
 * A row that still cannot be represented (its Product Set has no plan snapshot at all) is left in
 * place and counted in the log; it was already unreadable. `plan_promotion_snapshots.source_id`
 * keeps the legacy id, which is what the Professional Service ledger holds for a
 * `promotion_session` grant written before this stage. Data only, re-entrant; `down` restores
 * nothing (the plan snapshot rows are the record).
 */
const PLAN_ROW = `ump.recurrent_snapshot_id IS NULL
  AND EXISTS (SELECT 1 FROM promotions pr WHERE pr.id = ump.promotion_id AND pr.applies_to = 'membership_plan')`;

// The snapshot that holds the Promotions of the Product Set's primary plan snapshot.
const HOLDER = `(SELECT COALESCE(s.promotions_plan_snapshot_id, s.id)
                   FROM product_set_plan_snapshots j JOIN plan_snapshots s ON s.id = j.plan_snapshot_id
                  WHERE j.product_set_id = ump.product_set_id AND j.entitlement_only = 0
                  ORDER BY j.id LIMIT 1)`;

const GRANTS = [
  ['plan_promotion_session_product_snapshots', 'user_membership_promotion_session_snapshot'],
  ['plan_promotion_oneoff_product_snapshots', 'user_membership_promotion_oneoff_snapshot'],
  ['plan_promotion_periodical_product_snapshots', 'user_membership_promotion_periodical_snapshot'],
];

async function retireLegacyPlanPromotionRows(knex) {
  await knex.raw(
    `INSERT IGNORE INTO plan_promotion_snapshots
       (gym_id, plan_snapshot_id, source_id, promotion_id, status, is_inherited, snapshot, applied_at, applied_by,
        consumed_at, revoked_at, created_at, created_by, modified_at, modified_by, snapshot_confirmed_at)
     SELECT ump.gym_id, ${HOLDER}, ump.id, ump.promotion_id, ump.status, 0, ump.snapshot, ump.applied_at, ump.applied_by,
            ump.consumed_at, ump.revoked_at, ump.applied_at, ump.created_by, ump.modified_at, ump.modified_by,
            COALESCE(ump.snapshot_confirmed_at, ump.applied_at)
       FROM user_membership_promotions ump
      WHERE ${PLAN_ROW} AND ${HOLDER} IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM plan_promotion_snapshots tw WHERE tw.source_id = ump.id)
        AND NOT EXISTS (SELECT 1 FROM plan_promotion_snapshots q
                         WHERE q.plan_snapshot_id = ${HOLDER} AND q.promotion_id = ump.promotion_id)`);
  for (const [target, source] of GRANTS) {
    await knex.raw(
      `INSERT IGNORE INTO ${target}
         (gym_id, plan_promotion_snapshot_id, source_id, product_id, product_name, quantity, item_type,
          item_billing_frequency, unit_price, currency, \`action\`, \`value\`, requirement, created_at)
       SELECT g.gym_id, pps.id, g.id, g.product_id, g.product_name, g.quantity, g.item_type,
              g.item_billing_frequency, g.unit_price, g.currency, g.action, g.value, g.requirement, g.created_at
         FROM ${source} g
         JOIN plan_promotion_snapshots pps ON pps.source_id = g.user_membership_promotion_id AND pps.gym_id = g.gym_id
        WHERE NOT EXISTS (SELECT 1 FROM ${target} t WHERE t.plan_promotion_snapshot_id = pps.id)`);
  }
  const [deleted] = await knex.raw(
    `DELETE ump FROM user_membership_promotions ump
      WHERE ${PLAN_ROW}
        AND (EXISTS (SELECT 1 FROM plan_promotion_snapshots tw WHERE tw.source_id = ump.id)
             OR EXISTS (SELECT 1 FROM plan_promotion_snapshots q
                         WHERE q.plan_snapshot_id = ${HOLDER} AND q.promotion_id = ump.promotion_id))`);
  const [left] = await knex.raw(`SELECT COUNT(*) AS n FROM user_membership_promotions ump WHERE ${PLAN_ROW}`);
  return { deleted: Number(deleted.affectedRows ?? 0), left: Number(left[0].n) };
}

exports.retireLegacyPlanPromotionRows = retireLegacyPlanPromotionRows;

exports.up = async (knex) => {
  const out = await retireLegacyPlanPromotionRows(knex);
  // eslint-disable-next-line no-console
  console.log(`[451] legacy Plan Promotion rows deleted: ${out.deleted}; left (no plan snapshot): ${out.left}`);
};

exports.down = async () => {};
