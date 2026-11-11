/**
 * #2490 stage 3: a Direct Discount (%) on each Product line of a Membership Plan,
 * beside the line's Benefit treatment (`action`/`value`) rather than instead of it.
 *
 * `direct_discount_percent DECIMAL(5,2) NULL` on the three catalogue line tables
 * (`membership_plan_{session,oneoff,periodical}`) and on the three plan snapshot
 * line tables (`plan_{session,oneoff,periodical}_snapshots`), so an assignment keeps
 * the discount it was agreed with. NULL means no direct discount, which is what every
 * existing line reads as: no backfill, so no stored price moves.
 *
 * No CHECK, as with `mandatory` (#1184 stage 2): `ADD CONSTRAINT` rebuilds the table
 * under ALGORITHM=COPY, and `parseLineDirectDiscountInput()`
 * (`api/src/domain/lineDirectDiscount.ts`) is the one place a value is judged
 * (0..100), with `toLineDirectDiscount()` clamping what a reader takes.
 */

const TABLES = [
  'membership_plan_session', 'membership_plan_oneoff', 'membership_plan_periodical',
  'plan_session_snapshots', 'plan_oneoff_snapshots', 'plan_periodical_snapshots',
];

exports.up = async (knex) => {
  for (const table of TABLES) {
    if (await knex.schema.hasColumn(table, 'direct_discount_percent')) continue;
    await knex.raw(`ALTER TABLE ${table} ADD COLUMN direct_discount_percent DECIMAL(5,2) NULL`);
  }
};

exports.down = async (knex) => {
  for (const table of TABLES) {
    if (!(await knex.schema.hasColumn(table, 'direct_discount_percent'))) continue;
    await knex.raw(`ALTER TABLE ${table} DROP COLUMN direct_discount_percent`);
  }
};
