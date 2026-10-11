/**
 * #1325 PR 3e-4a — an assignment's benefit rows, applied Promotions and
 * recurring services are its current ProductSet version's own.
 *
 * Until now the projection kept a **second copy** of those rows keyed to the
 * assignment (`user_membership_id`, `product_set_id IS NULL`) beside the
 * version's own (`product_set_id`), for the readers that had not moved. Every
 * reader now takes them through the assignment's latest linked version, so the
 * copies are redundant. For each assignment-keyed row:
 *
 *  - when its version already holds the same row (same Product, or same
 *    Promotion / start date), the copy is **deleted** — after the renewals of a
 *    plan Session Benefit line that hung off the copy are re-pointed at the
 *    version's own line, so a member's renewed allowance is not lost;
 *  - when it does not (an assignment whose configuration only ever existed as
 *    the assignment's own rows — the superseded version migration 258 gave it
 *    has a snapshot but no lines), the row is **moved**: `product_set_id` is set
 *    to the version, which keeps its id, its snapshots and its renewals.
 *
 * `user_membership_id` stays on the tables for now (coverage still reads the
 * assignment-keyed `user_membership_members`, PR 3e-4b). One-way: a copy that is
 * deleted is not recreated by `down()`, which is a no-op — the version's own
 * rows are the data.
 */

const LATEST = (col) =>
  `(SELECT p9.id FROM product_sets p9 WHERE p9.user_membership_id = ${col} ORDER BY p9.version DESC, p9.id DESC LIMIT 1)`;

exports.up = async function up(knex) {
  // Plan Session Benefit renewals hang off the line: re-point them first.
  await knex.raw(
    `UPDATE IGNORE plan_allowance_renewals par
       JOIN user_membership_session copy
         ON copy.id = par.user_membership_session_id AND copy.product_set_id IS NULL
        AND copy.user_membership_id IS NOT NULL
       JOIN user_membership_session own
         ON own.product_set_id = ${LATEST('copy.user_membership_id')}
        AND own.product_id = copy.product_id AND own.gym_id = copy.gym_id
        SET par.user_membership_session_id = own.id`);

  for (const table of ['user_membership_session', 'user_membership_oneoff', 'user_membership_periodical']) {
    await knex.raw(
      `DELETE copy FROM ${table} copy
         JOIN ${table} own
           ON own.product_set_id = ${LATEST('copy.user_membership_id')}
          AND own.product_id = copy.product_id AND own.gym_id = copy.gym_id
        WHERE copy.product_set_id IS NULL AND copy.user_membership_id IS NOT NULL`);
    await knex.raw(
      `UPDATE ${table} copy
          SET copy.product_set_id = ${LATEST('copy.user_membership_id')}
        WHERE copy.product_set_id IS NULL AND copy.user_membership_id IS NOT NULL
          AND ${LATEST('copy.user_membership_id')} IS NOT NULL`);
  }

  // Applied Promotions (their grant snapshots hang off the application's id).
  await knex.raw(
    `DELETE copy FROM user_membership_promotions copy
       JOIN user_membership_promotions own
         ON own.product_set_id = ${LATEST('copy.user_membership_id')}
        AND own.promotion_id = copy.promotion_id AND own.gym_id = copy.gym_id
        AND own.status = copy.status AND (own.applied_at <=> copy.applied_at)
      WHERE copy.product_set_id IS NULL AND copy.user_membership_id IS NOT NULL`);
  await knex.raw(
    `UPDATE user_membership_promotions copy
        SET copy.product_set_id = ${LATEST('copy.user_membership_id')}
      WHERE copy.product_set_id IS NULL AND copy.user_membership_id IS NOT NULL
        AND ${LATEST('copy.user_membership_id')} IS NOT NULL`);

  // Recurring services.
  await knex.raw(
    `DELETE copy FROM member_products_recurrent_snapshot copy
       JOIN member_products_recurrent_snapshot own
         ON own.product_set_id = ${LATEST('copy.user_membership_id')}
        AND own.product_id = copy.product_id AND own.gym_id = copy.gym_id
        AND own.starts_at <=> copy.starts_at
      WHERE copy.product_set_id IS NULL AND copy.user_membership_id IS NOT NULL`);
  await knex.raw(
    `UPDATE member_products_recurrent_snapshot copy
        SET copy.product_set_id = ${LATEST('copy.user_membership_id')}
      WHERE copy.product_set_id IS NULL AND copy.user_membership_id IS NOT NULL
        AND ${LATEST('copy.user_membership_id')} IS NOT NULL`);
};

exports.down = async function down() {
  // One-way: the version's own rows are the data.
};
