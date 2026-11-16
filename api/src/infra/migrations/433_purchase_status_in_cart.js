/**
 * #2949 stage 1 — a one-time purchase that is in the member's cart is stored as `in_cart` (it was
 * `draft`, #1657 stage 2 / #2746). A real state change, not a label: the two purchase snapshot tables
 * (`product_session_snapshots`, `product_oneoff_snapshots`) have their rows moved, their CHECK
 * narrowed to the new value and their column default changed.
 *
 *   chk_prsess_status / chk_proneoff_status   'in_cart','pending_payment','active','cancelled','superseded'
 *
 * `product_periodical_snapshots` keeps `draft`: a recurring line takes its Product Set's status, and
 * the Product Set's own `draft` is a later stage of #2949. The pending-purchase key (migration 411)
 * is keyed on `pending_payment` only and is unaffected.
 *
 * Order: drop the CHECK, move the rows, add the new CHECK — each step is safe to re-run. Adding a
 * CHECK rebuilds the table under ALGORITHM=COPY; both tables are small. `down` reverses it exactly.
 */

const TABLES = [
  { table: 'product_session_snapshots', check: 'chk_prsess_status' },
  { table: 'product_oneoff_snapshots', check: 'chk_proneoff_status' },
];

/** The purchase statuses (`MEMBER_PRODUCT_STATUSES`) plus `superseded`, kept from migration 348's CHECK. */
const PURCHASE_STATUSES = ['in_cart', 'pending_payment', 'active', 'cancelled', 'superseded'];
const UP_STATUSES = PURCHASE_STATUSES.map((s) => `'${s}'`).join(',');
const DOWN_STATUSES = "'draft','pending_payment','active','cancelled','superseded'";

async function hasCheck(knex, table, name) {
  const [rows] = await knex.raw(
    `SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ? AND CONSTRAINT_TYPE = 'CHECK'`,
    [table, name]);
  return rows.length > 0;
}

async function move(knex, from, to, statuses) {
  for (const { table, check } of TABLES) {
    if (!(await knex.schema.hasTable(table))) continue;
    if (await hasCheck(knex, table, check)) await knex.raw(`ALTER TABLE ${table} DROP CHECK ${check}`);
    await knex.raw(`UPDATE ${table} SET status = ? WHERE status = ?`, [to, from]);
    await knex.raw(`ALTER TABLE ${table} ALTER COLUMN status SET DEFAULT '${to}'`);
    await knex.raw(`ALTER TABLE ${table} ADD CONSTRAINT ${check} CHECK (status IN (${statuses}))`);
  }
}

exports.up = async (knex) => {
  await move(knex, 'draft', 'in_cart', UP_STATUSES);
};

exports.down = async (knex) => {
  await move(knex, 'in_cart', 'draft', DOWN_STATUSES);
};

exports.PURCHASE_STATUSES = PURCHASE_STATUSES;
