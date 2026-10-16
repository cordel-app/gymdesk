/**
 * #1693 — the three dates of a Product a member bought.
 *
 * `member_products_oneoff_snapshot.purchased_at` already is the purchase date
 * (stamped by the payment webhook when the purchase turns `active`, never at
 * `pending_payment`), so nothing is added for it. This adds:
 *
 *  - `validity_days`  the Product's validity as agreed at purchase time
 *                     (snapshot of `products.validity_days`; NULL = none).
 *  - `valid_until`    the last day the purchase is valid, inclusive. Computed
 *                     once when the purchase completes and never overwritten by
 *                     a cancellation that falls inside the paid period. NULL =
 *                     no defined validity.
 *  - `cancelled_on`   the day the member's cancellation was recorded. Separate
 *                     from `status = 'cancelled'`, which only ever meant "the
 *                     payment never completed".
 *
 * All nullable, no backfill: a purchase written before this has no cancellation
 * or end date we could honestly invent.
 */
const TABLE = 'member_products_oneoff_snapshot';

async function addColumn(knex, name, ddl) {
  if (!(await knex.schema.hasColumn(TABLE, name))) {
    await knex.raw(`ALTER TABLE ${TABLE} ADD COLUMN ${name} ${ddl}`);
  }
}

exports.up = async (knex) => {
  await addColumn(knex, 'validity_days', 'INT UNSIGNED NULL');
  await addColumn(knex, 'valid_until', 'DATE NULL');
  await addColumn(knex, 'cancelled_on', 'DATE NULL');
};

exports.down = async (knex) => {
  for (const c of ['cancelled_on', 'valid_until', 'validity_days']) {
    if (await knex.schema.hasColumn(TABLE, c)) await knex.raw(`ALTER TABLE ${TABLE} DROP COLUMN ${c}`);
  }
};
