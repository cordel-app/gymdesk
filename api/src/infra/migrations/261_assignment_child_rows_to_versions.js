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

/**
 * Each table: how a copy is recognised as "the version already holds this row"
 * — the predicate of the unique key the version's rows live under, so a row
 * that is moved can never collide with one the version owns (migration 248:
 * one per product, one standing application per promotion, one open service
 * per product).
 */
const TABLES = [
  { table: 'user_membership_session', kind: 'plan_session',
    same: 'own.product_id = copy.product_id' },
  { table: 'user_membership_oneoff', kind: null,
    same: 'own.product_id = copy.product_id' },
  { table: 'user_membership_periodical', kind: null,
    same: 'own.product_id = copy.product_id' },
  { table: 'user_membership_promotions', kind: 'promotion_session',
    same: "own.promotion_id = copy.promotion_id AND own.status = 'applied' AND copy.status = 'applied'" },
  { table: 'member_products_recurrent_snapshot', kind: 'membership_service',
    same: 'own.product_id = copy.product_id AND own.ends_at IS NULL AND copy.ends_at IS NULL' },
];

const COPY = 'copy.product_set_id IS NULL AND copy.user_membership_id IS NOT NULL';
const OWN = (t) =>
  `JOIN ${t.table} own ON own.product_set_id = ${LATEST('copy.user_membership_id')}
        AND own.gym_id = copy.gym_id AND ${t.same}`;

exports.up = async function up(knex) {
  // Plan Session Benefit renewals hang off the line: re-point them to the
  // version's own line first (a renewal date the own line already has stays on
  // the copy and goes with it).
  await knex.raw(
    `UPDATE plan_allowance_renewals par
       JOIN user_membership_session copy
         ON copy.id = par.user_membership_session_id AND ${COPY}
       ${OWN(TABLES[0])}
        SET par.user_membership_session_id = own.id
      WHERE NOT EXISTS (SELECT 1 FROM (SELECT user_membership_session_id AS l, renewal_date AS d
                                         FROM plan_allowance_renewals) x
                         WHERE x.l = own.id AND x.d = par.renewal_date)`);

  for (const t of TABLES) {
    // What a spent session or a billed line points at is the row's id: carry
    // those references over to the row that survives.
    if (t.kind) {
      await knex.raw(
        `UPDATE professional_service_consumptions psc
           JOIN ${t.table} copy ON copy.id = psc.source_reference_id AND ${COPY}
           ${OWN(t)}
            SET psc.source_reference_id = own.id
          WHERE psc.source_kind = ?`, [t.kind]);
    }
    if (t.table === 'user_membership_promotions') {
      await knex.raw(
        `UPDATE billing_event_lines bel
           JOIN ${t.table} copy ON copy.id = bel.promotion_application_id AND ${COPY}
           ${OWN(t)}
            SET bel.promotion_application_id = own.id`);
    }
    // Copies the version already holds are redundant.
    await knex.raw(
      `DELETE copy FROM ${t.table} copy ${OWN(t)} WHERE ${COPY}`);
    // The rest only ever existed as the assignment's own rows: they move onto
    // the version (a row the version holds under the same key is never moved).
    await knex.raw(
      `UPDATE ${t.table} copy
         LEFT JOIN ${t.table} own
           ON own.product_set_id = ${LATEST('copy.user_membership_id')}
          AND own.gym_id = copy.gym_id AND ${t.same}
          SET copy.product_set_id = ${LATEST('copy.user_membership_id')}
        WHERE ${COPY} AND own.id IS NULL
          AND ${LATEST('copy.user_membership_id')} IS NOT NULL`);
  }
};

exports.down = async function down() {
  // One-way: the version's own rows are the data.
};
