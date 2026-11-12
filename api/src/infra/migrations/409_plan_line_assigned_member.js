/**
 * #2657 stage 3 (option A): an Individual Product line of a Membership Plan is stored
 * once per member. `assigned_member_id` on the three plan snapshot line tables
 * (`plan_{session,oneoff,periodical}_snapshots`) names the member the line is for, with
 * its own `quantity` and `direct_discount_percent`, so a member's Direct Discount or
 * removal is an ordinary per-line edit.
 *
 * NULL is a line that is not split: a Shared (Family) Product, which is one line for the
 * whole plan, and every Individual line written before this migration. There is no
 * backfill here: an unsplit Individual line keeps reading through the default unit
 * distribution (#2609 stage 3, `domain/planUnitAssignees.ts`) exactly as before, and the
 * Draft writers split it (`syncPlanLineAllocations()`, `api/src/api/plan-line-allocation.ts`)
 * the first time its plan is configured. Splitting committed lines, whose allowance
 * renewals and consumption ledger point at the line's id, is a later stage.
 *
 * The line's identity in its plan snapshot moves from `(plan_snapshot_id, product_id)` to
 * `(plan_snapshot_id, product_id, member_key)`, where `member_key` is a VIRTUAL generated
 * `IFNULL(assigned_member_id, 0)`: a Product may then hold one line per member, and still at
 * most one unsplit line (a UNIQUE over the nullable column itself would admit any number of
 * NULLs). The new key is added before the old one is dropped, so `plan_snapshot_id`'s FK keeps
 * an index throughout.
 *
 * FK `ON DELETE SET NULL` (migration 385's shape for the purchase-side column): a
 * hard-deleted member's line falls back to the default distribution rather than
 * blocking the delete. One statement per table, so a failure leaves nothing half-added
 * behind the hasColumn guard (the old key's drop follows in its own statement,
 * guarded by its own existence check); ADD CONSTRAINT rebuilds the table under ALGORITHM=COPY.
 */

const TABLES = [
  ['plan_session_snapshots', 'plsess'],
  ['plan_oneoff_snapshots', 'ploneoff'],
  ['plan_periodical_snapshots', 'plperiod'],
];

async function hasIndex(knex, table, name) {
  const [rows] = await knex.raw(
    'SELECT 1 FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ? LIMIT 1',
    [table, name]);
  return rows.length > 0;
}

exports.up = async (knex) => {
  for (const [table, abbr] of TABLES) {
    if (!(await knex.schema.hasColumn(table, 'assigned_member_id'))) await knex.raw(`
      ALTER TABLE ${table}
        ADD COLUMN assigned_member_id INT UNSIGNED NULL,
        ADD COLUMN member_key INT UNSIGNED GENERATED ALWAYS AS (IFNULL(assigned_member_id, 0)) VIRTUAL,
        ADD KEY ${abbr}_member_index (assigned_member_id),
        ADD UNIQUE KEY ${abbr}_snapshot_line_key (plan_snapshot_id, product_id, member_key),
        ADD CONSTRAINT ${abbr}_member_fk FOREIGN KEY (assigned_member_id)
          REFERENCES members (id) ON DELETE SET NULL`);
    if (await hasIndex(knex, table, `${abbr}_snapshot_product_key`)) {
      await knex.raw(`ALTER TABLE ${table} DROP INDEX ${abbr}_snapshot_product_key`);
    }
  }
};

exports.down = async (knex) => {
  for (const [table, abbr] of TABLES) {
    if (!(await knex.schema.hasColumn(table, 'assigned_member_id'))) continue;
    // A split line has siblings on its Product, which the old key refuses: down is only
    // possible while no plan holds one.
    await knex.raw(`ALTER TABLE ${table} ADD UNIQUE KEY ${abbr}_snapshot_product_key (plan_snapshot_id, product_id)`);
    await knex.raw(`
      ALTER TABLE ${table}
        DROP FOREIGN KEY ${abbr}_member_fk,
        DROP INDEX ${abbr}_snapshot_line_key,
        DROP KEY ${abbr}_member_index,
        DROP COLUMN member_key,
        DROP COLUMN assigned_member_id`);
  }
};
