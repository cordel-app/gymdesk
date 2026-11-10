/**
 * #2609 stage 1: `assigned_member_id` — the family member an Individual Product
 * assignment is for — on the two purchase tables and their #2126 snapshot mirrors.
 *
 * Nullable, FK to `members` ON DELETE SET NULL, no CHECK. No backfill: a row written
 * before this migration holds NULL and is read as the purchaser (a one-time purchase)
 * or the Product Set owner (a recurring line), which is who held it until now; a
 * `shared` Product stores NULL too and reads the same way (the purchaser holds it for
 * the family). The writers fill it from the first row written after the migration
 * (`api/src/api/product-assignee.ts`).
 */

const TABLES = [
  ['member_products_oneoff_snapshot', 'mprod_assignee'],
  ['member_products_recurrent_snapshot', 'mprec_assignee'],
  ['product_session_snapshots', 'prsess_assignee'],
  ['product_oneoff_snapshots', 'proneoff_assignee'],
  ['product_periodical_snapshots', 'prperiod_assignee'],
];

exports.up = async (knex) => {
  for (const [table, abbr] of TABLES) {
    if (await knex.schema.hasColumn(table, 'assigned_member_id')) continue;
    await knex.raw(`ALTER TABLE ${table} ADD COLUMN assigned_member_id INT UNSIGNED NULL`);
    await knex.raw(`ALTER TABLE ${table} ADD INDEX ${abbr}_index (assigned_member_id)`);
    await knex.raw(
      `ALTER TABLE ${table} ADD CONSTRAINT ${abbr}_fk FOREIGN KEY (assigned_member_id) `
      + 'REFERENCES members (id) ON DELETE SET NULL',
    );
  }
};

exports.down = async (knex) => {
  for (const [table, abbr] of TABLES) {
    if (!(await knex.schema.hasColumn(table, 'assigned_member_id'))) continue;
    await knex.raw(`ALTER TABLE ${table} DROP FOREIGN KEY ${abbr}_fk`);
    await knex.raw(`ALTER TABLE ${table} DROP INDEX ${abbr}_index`);
    await knex.raw(`ALTER TABLE ${table} DROP COLUMN assigned_member_id`);
  }
};
