/**
 * #1521 stage 2 — what a staff-initiated Product purchase can carry: several
 * stackable Promotions and one direct discount.
 *
 *  1. `member_products_oneoff_promotion_snapshot`: a purchase may now hold more
 *     than one applied Promotion (Oscar's decision 2 on #1521: allowed only
 *     when every one is `stackable`, which is enforced server-side). The old
 *     `UNIQUE (member_product_id)` is replaced by
 *     `UNIQUE (member_product_id, promotion_id)` — the same Promotion twice on
 *     one purchase stays impossible. Existing rows are untouched, and each
 *     keeps being "the" Promotion of its purchase. The new key is created
 *     before the old one is dropped because the purchase FK needs an index
 *     whose first column is `member_product_id` at every moment.
 *
 *  2. `member_products_oneoff_snapshot`: the direct discount (a percentage
 *     applied by an Admin to the VAT-inclusive price after any Promotions) is
 *     frozen with the purchase, together with the list price it started from,
 *     so a later price or tax change moves nothing about it (#635 §16's rule).
 *     All three columns are NULL for every purchase written before this
 *     migration and for a member-initiated one.
 *
 *  3. `member_products_recurrent_snapshot`: a recurring Product a direct
 *     discount was agreed on carries the same two facts beside its frozen
 *     `unit_price` (which already holds the discounted price, so the billing
 *     engine needs no change). NULL when no direct discount was agreed.
 *
 * No data is moved, deleted or backfilled.
 */
const PROMO = 'member_products_oneoff_promotion_snapshot';
const PURCHASE = 'member_products_oneoff_snapshot';
const RECURRENT = 'member_products_recurrent_snapshot';

async function hasIndex(knex, table, name) {
  const [rows] = await knex.raw(
    `SELECT 1 FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1`,
    [table, name],
  );
  return rows.length > 0;
}

async function hasCheck(knex, name) {
  const [rows] = await knex.raw(
    `SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
      WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_NAME = ? AND CONSTRAINT_TYPE = 'CHECK' LIMIT 1`,
    [name],
  );
  return rows.length > 0;
}

exports.up = async (knex) => {
  if (!(await hasIndex(knex, PROMO, 'mprodp_purchase_promotion_key'))) {
    await knex.raw(
      `ALTER TABLE ${PROMO} ADD UNIQUE KEY mprodp_purchase_promotion_key (member_product_id, promotion_id)`,
    );
  }
  if (await hasIndex(knex, PROMO, 'mprodp_purchase_key')) {
    await knex.raw(`ALTER TABLE ${PROMO} DROP INDEX mprodp_purchase_key`);
  }

  for (const [column, ddl] of [
    ['list_price', 'DECIMAL(10,2) NULL'],
    ['direct_discount_percent', 'DECIMAL(5,2) NULL'],
    ['direct_discount_amount', 'DECIMAL(10,2) NULL'],
  ]) {
    if (!(await knex.schema.hasColumn(PURCHASE, column))) {
      await knex.raw(`ALTER TABLE ${PURCHASE} ADD COLUMN ${column} ${ddl}`);
    }
  }
  // A discount is all three facts or none: the percentage, its amount and the
  // list price it was taken from. Every branch is NULL-safe — a NULL CHECK
  // result passes in MySQL, so each column is tested explicitly.
  if (await hasCheck(knex, 'chk_mprod_direct_discount')) {
    await knex.raw(`ALTER TABLE ${PURCHASE} DROP CHECK chk_mprod_direct_discount`);
  }
  await knex.raw(
    `ALTER TABLE ${PURCHASE} ADD CONSTRAINT chk_mprod_direct_discount CHECK (
       (direct_discount_percent IS NULL AND direct_discount_amount IS NULL)
       OR (direct_discount_percent IS NOT NULL AND direct_discount_percent > 0
           AND direct_discount_percent < 100
           AND direct_discount_amount IS NOT NULL AND direct_discount_amount > 0
           AND list_price IS NOT NULL AND direct_discount_amount <= list_price)
     )`,
  );

  for (const [column, ddl] of [
    ['list_unit_price', 'DECIMAL(10,2) NULL'],
    ['direct_discount_percent', 'DECIMAL(5,2) NULL'],
  ]) {
    if (!(await knex.schema.hasColumn(RECURRENT, column))) {
      await knex.raw(`ALTER TABLE ${RECURRENT} ADD COLUMN ${column} ${ddl}`);
    }
  }
  if (await hasCheck(knex, 'chk_mprec_direct_discount')) {
    await knex.raw(`ALTER TABLE ${RECURRENT} DROP CHECK chk_mprec_direct_discount`);
  }
  await knex.raw(
    `ALTER TABLE ${RECURRENT} ADD CONSTRAINT chk_mprec_direct_discount CHECK (
       (direct_discount_percent IS NULL AND list_unit_price IS NULL)
       OR (direct_discount_percent IS NOT NULL AND direct_discount_percent > 0
           AND direct_discount_percent < 100
           AND list_unit_price IS NOT NULL AND list_unit_price >= 0)
     )`,
  );
};

exports.down = async (knex) => {
  // Reversing would have to choose which of several Promotions of one purchase
  // to keep, and would discard a discount that is part of a charge's record:
  // nothing is dropped.
};
