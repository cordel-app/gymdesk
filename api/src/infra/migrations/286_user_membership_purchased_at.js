/**
 * #1695 — the date an assigned Membership Plan was successfully purchased.
 *
 * `user_memberships` already carried the other lifecycle dates: `starts_at`
 * (entitlement begins), `closed_at` (the moment it was cancelled — reused as
 * the cancellation date, so no second column) and `ends_at` (last entitled
 * day, #1196). `purchased_at` is the missing one: written once, when the
 * assignment first becomes `active` (payment confirmed, or committed with
 * nothing owed), never overwritten.
 *
 * Nullable, no backfill: nothing on an existing row establishes when it was
 * paid for, and a date invented from `created_at` would be wrong for every
 * plan that sat in Draft or Pending Payment first.
 */
const TABLE = 'user_memberships';

exports.up = async (knex) => {
  if (await knex.schema.hasColumn(TABLE, 'purchased_at')) return;
  await knex.raw(`ALTER TABLE ${TABLE} ADD COLUMN purchased_at DATETIME NULL AFTER closed_at`);
};

exports.down = async (knex) => {
  if (await knex.schema.hasColumn(TABLE, 'purchased_at')) {
    await knex.raw(`ALTER TABLE ${TABLE} DROP COLUMN purchased_at`);
  }
};
