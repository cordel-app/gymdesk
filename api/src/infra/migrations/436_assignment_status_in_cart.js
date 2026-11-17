/**
 * #2949 stage 3 — a Membership Plan assignment in the member's cart is stored as `in_cart` (it was
 * `draft`, #1108 stage 1, migration 227). A real state change, not a label: the rows move and the
 * CHECKs follow.
 *
 *   user_memberships  user_memberships_status_check  'in_cart','pending_payment','active','paused',
 *                                                    'active_cancel_at_period_end','cancelled','expired','superseded'
 *   plan_snapshots    chk_plan_snapshots_status      the same list; column DEFAULT 'in_cart'
 *
 * A plan snapshot holds its assignment's status, so it moves with it; stage 2's mapping of a set's
 * `in_cart` onto its plan snapshots as `draft` (`planSnapshotStatusForSet()`) goes away with this.
 * `user_memberships.status` keeps its DEFAULT 'active' (every writer names the column).
 *
 * Each step is safe to re-run: the CHECK is dropped if present, the UPDATE moves only `from` rows, and
 * the CHECK is added again with the target list. No generated column or index names the value. The
 * CHECKs rebuild both tables under ALGORITHM=COPY; merge outside the nightly runs and the 15-minute
 * booking-reminder pass. The API that reads and writes `in_cart` must ship in the same deploy: until
 * it starts, the previous build's `draft` writes fail the CHECK (migrations 433 and 434 had the same
 * window). `down` reverses it exactly.
 */

const ER_CHECK_CONSTRAINT_NOT_FOUND = 3940;
const OTHER_STATUSES = [
  'pending_payment', 'active', 'paused', 'active_cancel_at_period_end', 'cancelled', 'expired', 'superseded',
];

const list = (values) => values.map((v) => `'${v}'`).join(',');

async function addCheck(knex, table, check, values) {
  await knex.raw(`ALTER TABLE ${table} ADD CONSTRAINT ${check} CHECK (status IN (${list(values)}))`);
}

async function dropCheck(knex, table, check) {
  await knex.raw(`ALTER TABLE ${table} DROP CHECK ${check}`).catch((err) => {
    if (err.errno !== ER_CHECK_CONSTRAINT_NOT_FOUND) throw err;
  });
}

async function move(knex, from, to) {
  await dropCheck(knex, 'user_memberships', 'user_memberships_status_check');
  await knex.raw('UPDATE user_memberships SET status = ? WHERE status = ?', [to, from]);
  await addCheck(knex, 'user_memberships', 'user_memberships_status_check', [to, ...OTHER_STATUSES]);

  await dropCheck(knex, 'plan_snapshots', 'chk_plan_snapshots_status');
  await knex.raw('UPDATE plan_snapshots SET status = ? WHERE status = ?', [to, from]);
  await knex.raw(`ALTER TABLE plan_snapshots ALTER COLUMN status SET DEFAULT '${to}'`);
  await addCheck(knex, 'plan_snapshots', 'chk_plan_snapshots_status', [to, ...OTHER_STATUSES]);
}

exports.up = async (knex) => {
  await move(knex, 'draft', 'in_cart');
};

exports.down = async (knex) => {
  await move(knex, 'in_cart', 'draft');
};
