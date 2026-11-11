/**
 * #2609 stage 3: `unit_assignees` — which family member receives each unit of an
 * Individual Product a Membership Plan includes — on the three plan snapshot line tables.
 *
 * A JSON array of member ids, one entry per unit of the line's quantity, nullable and
 * with no CHECK. NULL means "the default distribution" (one unit per beneficiary of the
 * plan, in order, wrapping when there are more units than beneficiaries), which is what
 * every line written before this migration reads as; there is no backfill, so no stored
 * line changes. The writer is `PUT /user-memberships/:id/benefit-assignees`
 * (`api/src/api/plan-unit-assignees.ts`), and `domain/planUnitAssignees.ts` decides what a
 * stored value resolves to when the quantity, the beneficiaries or the family moved since.
 * A JSON column rather than a child table: the line is copied as a whole by
 * `copyPlanSnapshotToVersion()` and replaced per version, so the distribution travels with it.
 */

const TABLES = ['plan_session_snapshots', 'plan_oneoff_snapshots', 'plan_periodical_snapshots'];

exports.up = async (knex) => {
  for (const table of TABLES) {
    if (await knex.schema.hasColumn(table, 'unit_assignees')) continue;
    await knex.raw(`ALTER TABLE ${table} ADD COLUMN unit_assignees JSON NULL`);
  }
};

exports.down = async (knex) => {
  for (const table of TABLES) {
    if (!(await knex.schema.hasColumn(table, 'unit_assignees'))) continue;
    await knex.raw(`ALTER TABLE ${table} DROP COLUMN unit_assignees`);
  }
};
