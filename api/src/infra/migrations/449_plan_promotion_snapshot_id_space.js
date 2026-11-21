/**
 * #3026 stage 3c-3: a Plan Promotion application written without a legacy twin is identified by
 * its own `plan_promotion_snapshots.id`.
 *
 * Until now every row a reader identified had `source_id` (the `user_membership_promotions` id),
 * which is also what the Professional Service ledger holds for a `promotion_session` grant. Since
 * this stage a copy made with its plan snapshot keeps no twin, and its grant is identified by the
 * row's own id (`COALESCE(source_id, id)`). So that such an id can never be read as a legacy
 * application's, the table's AUTO_INCREMENT is put above every legacy application id (with a
 * headroom for rows written while this deploys), the device migration 412 used for recurring lines.
 * No row is changed; `down` is a no-op (an AUTO_INCREMENT is never lowered below existing ids).
 */
const HEADROOM = 100000;

exports.up = async (knex) => {
  const [rows] = await knex.raw(
    `SELECT GREATEST(
              (SELECT COALESCE(MAX(id), 0) FROM user_membership_promotions),
              (SELECT COALESCE(MAX(id), 0) FROM plan_promotion_snapshots),
              (SELECT COALESCE(MAX(source_id), 0) FROM plan_promotion_snapshots)) AS top`);
  const next = Number(rows[0].top) + HEADROOM;
  await knex.raw(`ALTER TABLE plan_promotion_snapshots AUTO_INCREMENT = ${next}`);
};

exports.down = async () => {};
