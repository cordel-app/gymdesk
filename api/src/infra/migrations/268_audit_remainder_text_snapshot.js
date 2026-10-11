/**
 * #1182 stage 4: the remainder. Same rules as migrations 265 and 267.
 *
 *  - `feature_flags` said `updated_at` / `updated_by_name`; it becomes
 *    `modified_at` / `modified_by`. `muscles` (a Cordel-administered catalogue)
 *    converts its `_by_name`/`_by_type` pair to the plain-text columns.
 *  - `staff_centers`, `trainer_availability`, `billing_events`,
 *    `payment_requests` and `plan_allowance_renewals` gain the text columns
 *    their lifecycle has.
 *  - Where the actor was a Clerk user id (`billing_events.actor_user_id` /
 *    `modified_by_user_id`, `payment_requests.initiated_by` /
 *    `modified_by_user_id`) the name is resolved through
 *    `gym_memberships (gym_id, user_id)`; the ids stay as the record.
 *  - `plan_allowance_renewals` is written only by the nightly renewal run, so its
 *    existing rows are `System`.
 *
 * The `*_by_membership_id` / `*_user_id` columns are kept as history and nothing
 * writes them any more.
 */
const TABLES = [
  'muscles', 'staff_centers', 'trainer_availability', 'billing_events',
  'payment_requests', 'plan_allowance_renewals',
];

// The actor columns of these tables hold a Clerk user id.
const USER_ID_SOURCE = {
  billing_events: { created: 'actor_user_id', modified: 'modified_by_user_id' },
  payment_requests: { created: 'initiated_by', modified: 'modified_by_user_id' },
};

// Tables whose creator FK is spelled `assigned_by_membership_id`.
const FK_SOURCE = {
  staff_centers: { created: 'assigned_by_membership_id' },
};

const ACTIONS = [
  { name: 'created', at: 'created_at' },
  { name: 'modified', at: 'modified_at' },
  { name: 'deleted', at: 'deleted_at' },
];

async function columnsOf(knex, table) {
  const [rows] = await knex.raw(
    `SELECT column_name AS name, column_type AS type
       FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ?`, [table]);
  return new Map(rows.map((r) => [r.name, r.type]));
}

async function dropTypeChecks(knex, table, column) {
  const [rows] = await knex.raw(
    `SELECT tc.constraint_name AS name
       FROM information_schema.table_constraints tc
       JOIN information_schema.check_constraints cc
         ON cc.constraint_schema = tc.constraint_schema AND cc.constraint_name = tc.constraint_name
      WHERE tc.table_schema = DATABASE() AND tc.table_name = ?
        AND tc.constraint_type = 'CHECK' AND cc.check_clause LIKE ?`,
    [table, `%\`${column}\`%`]);
  for (const r of rows) await knex.raw(`ALTER TABLE \`${table}\` DROP CHECK \`${r.name}\``);
}

exports.up = async function up(knex) {
  const flagCols = await columnsOf(knex, 'feature_flags');
  if (flagCols.has('updated_at') && !flagCols.has('modified_at')) {
    await knex.raw(
      `ALTER TABLE feature_flags
         CHANGE COLUMN updated_at modified_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
         CHANGE COLUMN updated_by_name modified_by VARCHAR(255) NULL`);
  }
  for (const table of TABLES) {
    const cols = await columnsOf(knex, table);
    const clauses = [];
    for (const { name, at } of ACTIONS) {
      if (!cols.has(at)) continue;
      const by = `${name}_by`;
      const byName = `${name}_by_name`;
      const byType = `${name}_by_type`;
      if (cols.has(byType)) {
        await dropTypeChecks(knex, table, byType);
        clauses.push(`DROP COLUMN \`${byType}\``);
      }
      if (cols.has(by) && !/^varchar/i.test(cols.get(by))) {
        throw new Error(`${table}.${by} exists as ${cols.get(by)}; migration 264 should have renamed it`);
      }
      if (cols.has(byName) && !cols.has(by)) {
        clauses.push(`CHANGE COLUMN \`${byName}\` \`${by}\` VARCHAR(255) NULL`);
      } else if (!cols.has(by)) {
        clauses.push(`ADD COLUMN \`${by}\` VARCHAR(255) NULL`);
      }
    }
    if (clauses.length) await knex.raw(`ALTER TABLE \`${table}\` ${clauses.join(', ')}`);

    // Backfill from the membership FK where the snapshot is still empty.
    const after = await columnsOf(knex, table);
    for (const { name, at } of ACTIONS) {
      const fk = FK_SOURCE[table]?.[name] ?? `${name}_by_membership_id`;
      if (!after.has(at) || !after.has(fk) || !after.has(`${name}_by`)) continue;
      await knex.raw(
        `UPDATE \`${table}\` t JOIN gym_memberships gm ON gm.id = t.\`${fk}\`
            SET t.\`${name}_by\` = gm.name
          WHERE t.\`${name}_by\` IS NULL AND gm.name IS NOT NULL AND gm.name <> ''`);
    }
  }

  // Actors recorded as a Clerk user id: resolve the name through the membership.
  for (const [table, sources] of Object.entries(USER_ID_SOURCE)) {
    for (const [name, source] of Object.entries(sources)) {
      await knex.raw(
        `UPDATE \`${table}\` t JOIN gym_memberships gm ON gm.user_id = t.\`${source}\` AND gm.gym_id = t.gym_id
            SET t.\`${name}_by\` = gm.name
          WHERE t.\`${name}_by\` IS NULL AND gm.name IS NOT NULL AND gm.name <> ''`);
    }
  }

  // The renewal run is the only writer of plan_allowance_renewals.
  await knex.raw(`UPDATE plan_allowance_renewals SET created_by = 'System' WHERE created_by IS NULL`);
};

// Lossy by nature (the actor type is gone and several columns were backfilled
// from a membership that may no longer exist): nothing to restore faithfully.
exports.down = async function down() {};
