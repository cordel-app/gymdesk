/**
 * #2833: a Promotion applied to a Draft stores no snapshot until the Draft is confirmed.
 *
 * #2624 stage 4 (migration 406) kept a *working copy* on a Draft's unconfirmed application
 * (`user_membership_promotions.snapshot_confirmed_at IS NULL`): its `snapshot` JSON and its grant
 * snapshot rows, re-taken at confirmation. #2833 removes that copy: while the Draft is configured
 * the application is only a reference to the Promotion, read live, and the snapshot is taken in
 * the transaction that confirms the Draft (`confirmDraftPromotionSnapshots()`).
 *
 * This clears the working copies that already exist, so the data matches the rule: for every
 * unconfirmed application on a Draft the grant snapshot rows (its own, the plan snapshot's and the Product
 * line's copies) are deleted and the `snapshot` JSON (its own and the two copies) is set NULL. The
 * readers already resolve an unconfirmed application live whatever it holds, so nothing they show
 * or price moves. A confirmed application is never touched (406 confirmed every application that
 * is not on a Draft still being configured). Data only, re-entrant; `down` restores nothing — the
 * next confirmation of each Draft takes the snapshot from the Promotion as it then stands.
 */
const UNCONFIRMED = `ump.snapshot_confirmed_at IS NULL AND EXISTS (
  SELECT 1 FROM product_sets draft_ps WHERE draft_ps.id = ump.product_set_id AND draft_ps.status = 'draft')`;

exports.up = async (knex) => {
  for (const table of [
    'user_membership_promotion_session_snapshot',
    'user_membership_promotion_oneoff_snapshot',
    'user_membership_promotion_periodical_snapshot',
  ]) {
    await knex.raw(
      `DELETE g FROM ${table} g
         JOIN user_membership_promotions ump ON ump.id = g.user_membership_promotion_id
        WHERE ${UNCONFIRMED}`);
  }
  for (const table of [
    'plan_promotion_session_product_snapshots',
    'plan_promotion_oneoff_product_snapshots',
    'plan_promotion_periodical_product_snapshots',
  ]) {
    await knex.raw(
      `DELETE t FROM ${table} t
         JOIN plan_promotion_snapshots pps ON pps.id = t.plan_promotion_snapshot_id
         JOIN user_membership_promotions ump ON ump.id = pps.source_id
        WHERE ${UNCONFIRMED}`);
  }
  await knex.raw(
    `DELETE g FROM product_promotion_grant_snapshots g
       JOIN product_promotion_snapshots pp ON pp.id = g.product_promotion_snapshot_id
       JOIN user_membership_promotions ump ON ump.id = pp.source_application_id
      WHERE ${UNCONFIRMED}`);
  await knex.raw(
    `UPDATE plan_promotion_snapshots pps
       JOIN user_membership_promotions ump ON ump.id = pps.source_id
        SET pps.snapshot = NULL
      WHERE ${UNCONFIRMED} AND pps.snapshot IS NOT NULL`);
  await knex.raw(
    `UPDATE product_promotion_snapshots pp
       JOIN user_membership_promotions ump ON ump.id = pp.source_application_id
        SET pp.snapshot = NULL
      WHERE ${UNCONFIRMED} AND pp.snapshot IS NOT NULL`);
  await knex.raw(
    `UPDATE user_membership_promotions ump SET ump.snapshot = NULL
      WHERE ${UNCONFIRMED} AND ump.snapshot IS NOT NULL`);
};

exports.down = async () => {};
