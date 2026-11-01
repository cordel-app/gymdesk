/**
 * #2125 stage 16 — the version-keyed benefit tables are gone.
 *
 * `user_membership_session`, `user_membership_oneoff` and `user_membership_periodical` held a
 * ProductSet version's included Products, one plan per version. The included Products are the
 * plan snapshot's own lines now (`plan_session/oneoff/periodical_snapshots`, migration 347), written
 * and read there by every path; a plan beyond the first never had a row in the old tables.
 *
 * Safety: migration 347's backfill is repeatable (keyed by `source_id`), so it runs once more
 * first and copies any legacy row that lacks its snapshot twin; a row it cannot copy (a version
 * with no plan snapshot) aborts the migration before anything is dropped. `plan_allowance_renewals.user_membership_session_id` (frozen record of older rows,
 * nullable since migration 354) loses its FK and keeps the plain value.
 *
 * `down` cannot restore the tables' rows: they live in the plan snapshot tables, which stay.
 */
const TABLES = ['user_membership_session', 'user_membership_oneoff', 'user_membership_periodical'];
const TWIN = {
  user_membership_session: 'plan_session_snapshots',
  user_membership_oneoff: 'plan_oneoff_snapshots',
  user_membership_periodical: 'plan_periodical_snapshots',
};

/**
 * The backfill copies a legacy row only under a plan snapshot of its version, so a row on a
 * version that has none (no Membership Plan, no plan row) would be dropped with the table. Abort
 * before any DDL rather than lose it silently.
 */
async function assertEveryRowHasATwin(knex, tables) {
  for (const t of tables) {
    const [[row]] = await knex.raw(
      `SELECT COUNT(*) AS n FROM \`${t}\` u WHERE NOT EXISTS (SELECT 1 FROM \`${TWIN[t]}\` x WHERE x.source_id = u.id)`);
    if (Number(row.n) > 0) {
      throw new Error(`migration 355: ${row.n} row(s) of ${t} have no plan snapshot twin; nothing was dropped`);
    }
  }
}
exports.assertEveryRowHasATwin = assertEveryRowHasATwin;

exports.up = async (knex) => {
  const present = [];
  for (const t of TABLES) if (await knex.schema.hasTable(t)) present.push(t);
  if (present.length === 0) return;

  const { backfillPlanSnapshots } = require('./347_plan_snapshots');
  await backfillPlanSnapshots(knex);
  await assertEveryRowHasATwin(knex, present);

  // Every foreign key that still points at one of the tables.
  const [fks] = await knex.raw(
    `SELECT table_name AS t, constraint_name AS c FROM information_schema.referential_constraints
      WHERE constraint_schema = DATABASE() AND referenced_table_name IN (${present.map(() => '?').join(',')})`,
    present);
  for (const fk of fks) await knex.raw(`ALTER TABLE \`${fk.t}\` DROP FOREIGN KEY \`${fk.c}\``);
  for (const t of present) await knex.schema.dropTableIfExists(t);
};

exports.down = async () => {
  // Irreversible by design: the data is in plan_session/oneoff/periodical_snapshots.
};
