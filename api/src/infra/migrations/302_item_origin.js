/**
 * #1883 — where a Product or Membership Plan in a member's ProductSet came from.
 *
 * `origin` is `members_app` (the member added or bought it themselves) or
 * `admin` (a staff member did), stored on the snapshot row of the specific
 * assignment or purchase: the recurring Product lines, the one-off purchases and
 * the Membership Plan snapshot of a version. NULL means the origin cannot be
 * known — every row written before this migration — and is read as Unknown;
 * nothing is backfilled, because guessing from a role is exactly what the
 * ticket forbids. There is no CHECK (ALGORITHM=COPY on busy tables): the
 * accepted set is `api/src/domain/itemOrigin.ts`.
 */

const TABLES = [
  'member_products_recurrent_snapshot',
  'member_products_oneoff_snapshot',
  'product_set_plan_snapshots',
];

exports.up = async (knex) => {
  for (const table of TABLES) {
    if (!(await knex.schema.hasColumn(table, 'origin'))) {
      await knex.raw(`ALTER TABLE ${table} ADD COLUMN origin VARCHAR(16) NULL`);
    }
  }
};

exports.down = async (knex) => {
  for (const table of TABLES) {
    if (await knex.schema.hasColumn(table, 'origin')) {
      await knex.raw(`ALTER TABLE ${table} DROP COLUMN origin`);
    }
  }
};
