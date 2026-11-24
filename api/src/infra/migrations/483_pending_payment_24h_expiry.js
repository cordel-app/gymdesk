/**
 * #3307 stage 3 — a Pending Payment checkout expires after 24 hours.
 *
 *  - `billing_events.expired_at`: when the expiry pass (`expirePendingPayments()`) closed the
 *    checkout's initial event. The event is stamped `cancelled_at` in the same statement (so every
 *    reader that already leaves a cancelled event alone — the failed-payments queue, the member's
 *    payment status, a late payment that must activate nothing — keeps doing so), and `expired_at`
 *    is what makes it read **24h expired** instead of *Cancelled* (`displayBillingEventStatus()`).
 *  - `expired_24h` is a purchase snapshot status: a one-time Product of that checkout that was still
 *    `pending_payment` moves to it. The two CHECKs are widened (a superset of migration 433's set).
 *
 * Re-runnable: the column is added only when missing, each CHECK is dropped only when present. Adding
 * a CHECK rebuilds the table under ALGORITHM=COPY; both snapshot tables are small. `down` restores
 * migration 433's CHECKs after moving any `expired_24h` row to `cancelled`.
 */

const TABLES = [
  { table: 'product_session_snapshots', check: 'chk_prsess_status' },
  { table: 'product_oneoff_snapshots', check: 'chk_proneoff_status' },
];

const UP_STATUSES = ['in_cart', 'pending_payment', 'active', 'cancelled', 'superseded', 'expired_24h'];
const DOWN_STATUSES = ['in_cart', 'pending_payment', 'active', 'cancelled', 'superseded'];
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
  if (!(await knex.schema.hasColumn('billing_events', 'expired_at'))) {
    await knex.raw('ALTER TABLE billing_events ADD COLUMN expired_at DATETIME NULL AFTER cancelled_by');
  }
  await setCheck(knex, UP_STATUSES);
};

exports.down = async (knex) => {
  await setCheck(knex, DOWN_STATUSES, (table) =>
    knex.raw(`UPDATE ${table} SET status = 'cancelled' WHERE status = 'expired_24h'`));
  if (await knex.schema.hasColumn('billing_events', 'expired_at')) {
    await knex.raw('ALTER TABLE billing_events DROP COLUMN expired_at');
  }
};

exports.PURCHASE_STATUSES = UP_STATUSES;
