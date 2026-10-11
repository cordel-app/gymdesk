/**
 * #1182 stage 3, step 2: the assignment and lifecycle tables carry the
 * plain-text actor snapshot `created_by` / `modified_by` / `deleted_by`
 * (VARCHAR(255), NULL = nobody can be named), exactly as migration 265 did for
 * the primary entities and by the same rules:
 *
 *  - `<x>_by_name` is renamed `<x>_by`, `<x>_by_type` and its CHECK are dropped;
 *  - an action with no text column gets one (`created_at` / `modified_at` /
 *    `deleted_at` say which actions a table has);
 *  - where the row has an actor FK to `gym_memberships` and the text is empty,
 *    the name is backfilled from `gym_memberships.name` (a membership that no
 *    longer exists leaves NULL). A few tables spell the creator's FK
 *    `assigned_by_membership_id` (`FK_SOURCE`);
 *  - `user_membership_promotions.applied_by` is a Clerk user id: the creator's
 *    name is resolved through `gym_memberships (gym_id, user_id)` and the id
 *    stays as the record.
 *
 * The `*_by_membership_id` columns are never dropped: they are the record of who
 * acted before the snapshot existed, and nothing writes them any more.
 */
const TABLES = [
  'user_memberships', 'user_membership_promotions', 'promotions', 'product_sets',
  'member_products_oneoff_snapshot', 'member_personal_goal_readings',
  'training_plans', 'member_training_plans', 'calendar_event_bookings',
  'calendar_event_series', 'user_class_packages', 'class_package_transactions',
  'gym_professional_services', 'member_centers', 'member_recurring_slots',
];

// A Promotion application has no `created_at`: it was created when it was applied.
const AT_SOURCE = { user_membership_promotions: { created: 'applied_at' } };

// Tables whose creator FK is spelled `assigned_by_membership_id`.
const FK_SOURCE = {
  member_centers: { created: 'assigned_by_membership_id' },
  training_plans: { created: 'assigned_by_membership_id' },
  member_training_plans: { created: 'assigned_by_membership_id' },
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
  for (const table of TABLES) {
    const cols = await columnsOf(knex, table);
    const clauses = [];
    for (const { name, at } of ACTIONS) {
      if (!cols.has(AT_SOURCE[table]?.[name] ?? at)) continue;
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
      if (!after.has(AT_SOURCE[table]?.[name] ?? at) || !after.has(fk) || !after.has(`${name}_by`)) continue;
      await knex.raw(
        `UPDATE \`${table}\` t JOIN gym_memberships gm ON gm.id = t.\`${fk}\`
            SET t.\`${name}_by\` = gm.name
          WHERE t.\`${name}_by\` IS NULL AND gm.name IS NOT NULL AND gm.name <> ''`);
    }
  }

  // A Promotion application's creator: applied_by holds a Clerk user id.
  await knex.raw(
    `UPDATE user_membership_promotions ump
       JOIN gym_memberships gm ON gm.user_id = ump.applied_by AND gm.gym_id = ump.gym_id
        SET ump.created_by = gm.name
      WHERE ump.created_by IS NULL AND gm.name IS NOT NULL AND gm.name <> ''`);
};

// Lossy by nature (the actor type is gone and several columns were backfilled
// from a membership that may no longer exist): nothing to restore faithfully.
exports.down = async function down() {};
