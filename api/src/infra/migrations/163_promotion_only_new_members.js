/**
 * #633: Add `only_applicable_for_new_members` to promotions.
 *
 * A second boolean on the main Promotion configuration, grouped with
 * `stackable` in the UI. This ticket only adds and persists the flag —
 * nothing reads it yet: Promotion eligibility, stacking and the Assign Plan
 * to Member workflow are deliberately unchanged (see #633 §5). The behaviour
 * that consumes it lands in a separate ticket.
 *
 * NOT NULL DEFAULT 1 does the backfill in one statement: MySQL stamps every
 * existing row with `1`, which is the intended value for promotions created
 * before the flag existed (§ "Existing Promotions ... should receive the
 * default value true"). The column add is guarded with hasColumn so a retry
 * after a partial failure resumes cleanly, per the convention in
 * 093_promotions_v2.js / 161_membership_plan_price_status.js.
 */

exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('promotions', 'only_applicable_for_new_members'))) {
    await knex.schema.alterTable('promotions', (t) => {
      // t.boolean (tinyint(1)), matching the sibling `stackable` column that
      // 019_promotions.js created, so the two flags read the same in DDL.
      t.boolean('only_applicable_for_new_members').notNullable().defaultTo(1).after('stackable');
    });
  }
};

exports.down = async (knex) => {
  if (await knex.schema.hasColumn('promotions', 'only_applicable_for_new_members')) {
    await knex.schema.alterTable('promotions', (t) => {
      t.dropColumn('only_applicable_for_new_members');
    });
  }
};
