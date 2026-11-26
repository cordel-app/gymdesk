/**
 * #3307 stage 7 — a 24-hour Pending Payment expiry cancels the checkout's pending one-time Products.
 *
 * Migration 483 gave the purchase snapshots an `expired_24h` status. The owner's follow-up keeps
 * `expired_24h` as a Billing Event display status only (`billing_events.expired_at`, unchanged) and
 * has a pending Product of an expired checkout become `cancelled`, as it does when the checkout is
 * cancelled. This migration moves every `expired_24h` snapshot row to `cancelled` and narrows the two
 * CHECKs back to migration 433's set.
 *
 * Re-runnable: the UPDATE is a no-op once the rows moved, each CHECK is dropped only when present.
 * Adding a CHECK rebuilds the table under ALGORITHM=COPY; both snapshot tables are small. `down`
 * widens the CHECKs again and does not move a row back (which `cancelled` row was an expiry is not
 * recorded on the snapshot).
 */

const TABLES = [
  { table: 'product_session_snapshots', check: 'chk_prsess_status' },
  { table: 'product_oneoff_snapshots', check: 'chk_proneoff_status' },
];

const STATUSES = ['in_cart', 'pending_payment', 'active', 'cancelled', 'superseded'];
const WIDE_STATUSES = [...STATUSES, 'expired_24h'];
const list = (s) => s.map((x) => `'${x}'`).join(',');

async function hasCheck(knex, table, name) {
  const [rows] = await knex.raw(
    `SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ? AND CONSTRAINT_TYPE = 'CHECK'`,
    [table, name]);
  return rows.length > 0;
}

async function setCheck(knex, statuses, before) {
  for (const { table, check } of TABLES) {
    if (!(await knex.schema.hasTable(table))) continue;
    if (await hasCheck(knex, table, check)) await knex.raw(`ALTER TABLE ${table} DROP CHECK ${check}`);
    if (before) await before(table);
    await knex.raw(`ALTER TABLE ${table} ADD CONSTRAINT ${check} CHECK (status IN (${list(statuses)}))`);
  }
}

exports.up = async (knex) => {
  await setCheck(knex, STATUSES, (table) =>
    knex.raw(`UPDATE ${table} SET status = 'cancelled' WHERE status = 'expired_24h'`));
};

exports.down = async (knex) => {
  await setCheck(knex, WIDE_STATUSES);
};

exports.PURCHASE_STATUSES = STATUSES;
