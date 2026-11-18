/**
 * #3007 stage 2(a) — a Membership Plan assignment may be stored as `to_be_canceled`: a plan with a
 * cancellation pending that keeps running exactly like an `active` one until the cancellation is
 * committed. This migration only widens the two CHECKs; nothing writes the value yet (the writer is
 * the next stage) and no row moves.
 *
 *   user_memberships  user_memberships_status_check  the list + 'to_be_canceled'
 *   plan_snapshots    chk_plan_snapshots_status      the same list
 *
 * Each step is safe to re-run (the CHECK is dropped if present, then added with the target list).
 * The CHECKs rebuild both tables under ALGORITHM=COPY; merge outside the nightly runs and the
 * 15-minute booking-reminder pass. `down` restores the previous list and refuses to run while a row
 * holds the value, because narrowing the CHECK would then fail half way.
 */

const ER_CHECK_CONSTRAINT_NOT_FOUND = 3940;
const BASE = [
  'in_cart', 'pending_payment', 'active', 'paused', 'active_cancel_at_period_end', 'cancelled', 'expired', 'superseded',
];
const WIDENED = ['in_cart', 'pending_payment', 'active', 'to_be_canceled', 'paused', 'active_cancel_at_period_end', 'cancelled', 'expired', 'superseded'];

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
    const [[row]] = await knex.raw(`SELECT COUNT(*) AS n FROM ${table} WHERE status = 'to_be_canceled'`);
    if (Number(row.n) > 0) throw new Error(`${table} holds to_be_canceled rows; move them before reverting`);
  }
  await setCheck(knex, 'user_memberships', 'user_memberships_status_check', BASE);
  await setCheck(knex, 'plan_snapshots', 'chk_plan_snapshots_status', BASE);
};
