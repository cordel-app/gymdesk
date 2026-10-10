/**
 * #1325 PR 3b — every money row belongs to a ProductSet.
 *
 * `billing_events.product_set_id` may be NULL only for a one-off purchase
 * (`product_purchase`, outside the version chain by decision) and for a card
 * verification raised by a member who holds no Active set (`card_verification`,
 * amount 0). Everything else — a scheduled obligation, a first payment, a cash
 * payment, an adjustment, a waiver — is a version's, which is what lets the
 * ledger be read per chain and the editing lock be decided from it.
 *
 * Written now, after PR 3a, because the one writer that put a money row down
 * before its set existed — the Admin's Save & Pay, whose initial payment event
 * the commit used to import and link afterwards — creates the Pending Payment
 * version up front since this stage (`importAssignmentAsProductSet(…, {
 * pending: true })`), so no path is left that can satisfy the CHECK only after
 * the fact.
 *
 * Guard: a row that would violate the CHECK refuses the migration rather than
 * being rewritten — such a row is pre-ProductSet data the approved development
 * reset removes, and deleting or re-attributing money records is never a
 * side effect of deploying. `ADD CONSTRAINT … CHECK` rebuilds the table
 * (`ALGORITHM=COPY`); `billing_events` is small until production.
 */

const CHECK = 'chk_billing_events_product_set';

/** Event types a row may carry with no ProductSet. */
const SET_LESS_TYPES = ['product_purchase', 'card_verification'];

const ER_CHECK_CONSTRAINT_NOT_FOUND = 3940;
const dropCheckIfExists = (knex, sql) =>
  knex.raw(sql).catch((err) => {
    if (err.errno !== ER_CHECK_CONSTRAINT_NOT_FOUND) throw err;
  });

const hasConstraint = async (knex, table, name) => {
  const rows = await knex.raw(
    `SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ?`,
    [table, name],
  );
  return rows[0].length > 0;
};

exports.up = async (knex) => {
  const list = SET_LESS_TYPES.map((t) => `'${t}'`).join(',');
  const rows = await knex.raw(
    `SELECT COUNT(*) AS n FROM billing_events WHERE product_set_id IS NULL AND event_type NOT IN (${list})`,
  );
  const violating = Number(rows[0][0].n);
  if (violating > 0) {
    throw new Error(
      `migration 253 refused: ${violating} billing event(s) belong to no ProductSet. `
      + 'Run the approved development reset (npm run billing:reset-dev) first — this migration never '
      + 'deletes or re-attributes money records itself.',
    );
  }
  if (!(await hasConstraint(knex, 'billing_events', CHECK))) {
    await knex.raw(
      `ALTER TABLE billing_events ADD CONSTRAINT ${CHECK} `
      + `CHECK (product_set_id IS NOT NULL OR event_type IN (${list}))`,
    );
  }
};

exports.down = async (knex) => {
  await dropCheckIfExists(knex, `ALTER TABLE billing_events DROP CHECK ${CHECK}`);
};
