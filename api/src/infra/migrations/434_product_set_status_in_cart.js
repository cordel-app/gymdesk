/**
 * #2949 stage 2 — a Product Set in the member's cart is stored as `in_cart` (it was `draft`, #1325).
 * A real state change, not a label: the rows move, the CHECK and the column default follow, and so does
 * everything that keys on the value.
 *
 *   product_sets                  chk_product_sets_status   'in_cart','pending_payment','active','superseded','cancelled'
 *                                 pending_owner_key         IF(status IN ('in_cart','pending_payment'), owner, NULL)
 *   product_periodical_snapshots  chk_prperiod_status       'in_cart','pending_payment','active','cancelled','superseded'
 *
 * A recurring line takes its Product Set's status (`syncProductSnapshotsOfVersion()`), so its snapshot
 * table moves with it. A plan snapshot does not: it holds its assignment's status, and an assignment in
 * the cart stays `draft` until stage 3, so `planSnapshotStatusForSet()` writes a set's `in_cart` onto
 * its plan snapshots as `draft` and `plan_snapshots` is untouched here.
 *
 * `pending_owner_key` (the owner's one in-flight slot, `product_sets_one_in_flight`) names the status,
 * so its expression is widened to both values while the rows move and narrowed afterwards; the unique
 * index on it holds throughout, since a row is never in both. Each step is safe to re-run. The CHECK
 * and the column change rebuild both tables under ALGORITHM=COPY; merge outside the nightly runs and
 * the 15-minute booking-reminder pass. The API that reads and writes `in_cart` must ship in the same
 * deploy: until it starts, the previous build's `draft` writes fail the CHECK and its `draft` reads
 * find no cart (migration 433 had the same window). `down` reverses it exactly.
 */

const SET_STATUSES = ['pending_payment', 'active', 'superseded', 'cancelled'];
const LINE_STATUSES = ['pending_payment', 'active', 'cancelled', 'superseded'];

const list = (values) => values.map((v) => `'${v}'`).join(',');

async function dropCheck(knex, table, check) {
  const [rows] = await knex.raw(
    `SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ? AND CONSTRAINT_TYPE = 'CHECK'`,
    [table, check]);
  if (rows.length > 0) await knex.raw(`ALTER TABLE ${table} DROP CHECK ${check}`);
}

async function addCheck(knex, table, check, values) {
  await knex.raw(`ALTER TABLE ${table} ADD CONSTRAINT ${check} CHECK (status IN (${list(values)}))`);
}

async function setInFlightKey(knex, statuses) {
  await knex.raw(`
    ALTER TABLE product_sets MODIFY COLUMN pending_owner_key INT UNSIGNED
      GENERATED ALWAYS AS (IF(status IN (${list(statuses)}), owner_member_id, NULL)) VIRTUAL`);
}

async function move(knex, from, to) {
  // product_sets: drop the CHECK, key the in-flight slot on both values, move, then narrow.
  await dropCheck(knex, 'product_sets', 'chk_product_sets_status');
  await setInFlightKey(knex, [from, to, 'pending_payment']);
  await knex.raw('UPDATE product_sets SET status = ? WHERE status = ?', [to, from]);
  await knex.raw(`ALTER TABLE product_sets ALTER COLUMN status SET DEFAULT '${to}'`);
  await setInFlightKey(knex, [to, 'pending_payment']);
  await addCheck(knex, 'product_sets', 'chk_product_sets_status', [to, ...SET_STATUSES]);

  if (await knex.schema.hasTable('product_periodical_snapshots')) {
    await dropCheck(knex, 'product_periodical_snapshots', 'chk_prperiod_status');
    await knex.raw('UPDATE product_periodical_snapshots SET status = ? WHERE status = ?', [to, from]);
    await knex.raw(`ALTER TABLE product_periodical_snapshots ALTER COLUMN status SET DEFAULT '${to}'`);
    await addCheck(knex, 'product_periodical_snapshots', 'chk_prperiod_status', [to, ...LINE_STATUSES]);
  }
}

exports.up = async (knex) => {
  await move(knex, 'draft', 'in_cart');
};

exports.down = async (knex) => {
  await move(knex, 'in_cart', 'draft');
};
