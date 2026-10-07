/**
 * #1184 stage 2 — a Membership Plan's Product benefit carries a **Mandatory**
 * Yes/No: whether the member must keep the benefit when the Plan is assigned
 * (`1`, the default) or may decline it (`0`).
 *
 * The column goes on six tables, for the reason migrations 203, 205 and 207 put
 * their columns on the same shape:
 *
 *   membership_plan_session / _oneoff / _periodical       (the Plan's configuration)
 *   user_membership_session / _oneoff / _periodical        (the Assigned Plan's snapshot)
 *
 * The assignment side is not optional: an Assigned Plan owns what it was agreed
 * with (#635 §13–§17), so a flag that reached only the catalogue would be a
 * configuration no existing assignment could have been agreed with.
 *
 * **It is not `products.mandatory`** (#832/#893), the catalogue flag that forces
 * an item into every Plan. This one belongs to the Plan ↔ Product relationship.
 *
 * `TINYINT(1) NOT NULL DEFAULT 1` fills every existing row in the same statement
 * as `mandatory = 1`, which is what they mean: nothing could be declined before.
 * No CHECK: `ADD CONSTRAINT` rebuilds a table under `ALGORITHM=COPY`, and a
 * boolean the router coerces to 0/1 needs none (the `products.mandatory` rule,
 * migration 200).
 *
 * `down` refuses to drop a configured `0`: re-applying would call every optional
 * benefit mandatory, the opposite promise to the member.
 */
const TABLES = [
  'membership_plan_session',
  'membership_plan_oneoff',
  'membership_plan_periodical',
  'user_membership_session',
  'user_membership_oneoff',
  'user_membership_periodical',
];

exports.up = async (knex) => {
  for (const table of TABLES) {
    if (!(await knex.schema.hasColumn(table, 'mandatory'))) {
      await knex.schema.alterTable(table, (t) => {
        t.boolean('mandatory').notNullable().defaultTo(true);
      });
    }
  }
};

exports.down = async (knex) => {
  for (const table of TABLES) {
    if (!(await knex.schema.hasColumn(table, 'mandatory'))) continue;
    const [[optional]] = await knex.raw(`SELECT COUNT(*) AS cnt FROM \`${table}\` WHERE mandatory = 0`);
    if (optional.cnt > 0) {
      throw new Error(
        `${table} holds ${optional.cnt} optional benefit(s) — refusing to drop them. `
        + 'Re-applying this migration would call every one of them mandatory (see migration 237).',
      );
    }
  }
  for (const table of TABLES) {
    if (await knex.schema.hasColumn(table, 'mandatory')) {
      await knex.schema.alterTable(table, (t) => t.dropColumn('mandatory'));
    }
  }
};

exports.TABLES = TABLES;
