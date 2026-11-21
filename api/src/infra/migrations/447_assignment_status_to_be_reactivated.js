/**
 * #3114 — a Membership Plan assignment may be stored as `to_be_reactivated`: a plan cancelling at its
 * period end (`active_cancel_at_period_end`) that staff marked for reactivation in the owner's open In
 * Cart. It still entitles like the cancelling plan it is until the cart is committed (then `active`);
 * discarding the cart puts it back. This migration widens the two CHECKs; no row moves.
 *
 *   user_memberships  user_memberships_status_check  the list + 'to_be_reactivated'
 *   plan_snapshots    chk_plan_snapshots_status      the same list
 *
 * Each step is safe to re-run. The CHECKs rebuild both tables under ALGORITHM=COPY; merge outside the
 * nightly runs and the 15-minute booking-reminder pass. `down` restores the previous list and refuses to
 * run while a row holds the value.
 */

const ER_CHECK_CONSTRAINT_NOT_FOUND = 3940;
const BASE = [
  'in_cart', 'pending_payment', 'active', 'to_be_canceled', 'paused', 'active_cancel_at_period_end', 'cancelled', 'expired', 'superseded',
];
const WIDENED = [
  'in_cart', 'pending_payment', 'active', 'to_be_canceled', 'paused', 'active_cancel_at_period_end', 'to_be_reactivated', 'cancelled', 'expired', 'superseded',
];

const list = (values) => values.map((v) => `'${v}'`).join(',');

async function setCheck(knex, table, check, values) {
  await knex.raw(`ALTER TABLE ${table} DROP CHECK ${check}`).catch((err) => {
    if (err.errno !== ER_CHECK_CONSTRAINT_NOT_FOUND) throw err;
  });
  await knex.raw(`ALTER TABLE ${table} ADD CONSTRAINT ${check} CHECK (status IN (${list(values)}))`);
}

exports.up = async (knex) => {
  await setCheck(knex, 'user_memberships', 'user_memberships_status_check', WIDENED);
  await setCheck(knex, 'plan_snapshots', 'chk_plan_snapshots_status', WIDENED);
};

exports.down = async (knex) => {
  for (const table of ['user_memberships', 'plan_snapshots']) {
    const [[row]] = await knex.raw(`SELECT COUNT(*) AS n FROM ${table} WHERE status = 'to_be_reactivated'`);
    if (Number(row.n) > 0) throw new Error(`${table} holds to_be_reactivated rows; move them before reverting`);
  }
  await setCheck(knex, 'user_memberships', 'user_memberships_status_check', BASE);
  await setCheck(knex, 'plan_snapshots', 'chk_plan_snapshots_status', BASE);
};
