/**
 * #1182 stage 2, step 2: every in-scope table carries the plain-text actor
 * snapshot `created_by` / `modified_by` / `deleted_by` (VARCHAR(255), NULL =
 * nobody can be named — never an invented actor, §14).
 *
 * Per table, for each audit action the table has (`created_at`, `modified_at`,
 * `deleted_at`):
 *
 *  - #799's `<x>_by_name` is renamed `<x>_by` (the name was always the text);
 *    `<x>_by_type` and its CHECK are dropped — the new mechanism carries no actor
 *    type, the impersonation context lives in the string itself;
 *  - an action with no text column gets one added;
 *  - where the row still has `<x>_by_membership_id` and the text is empty, the
 *    name is backfilled from `gym_memberships.name`. A membership that no
 *    longer exists leaves NULL. Rows that already hold a snapshot keep it
 *    (`exercises`, `tax_rates` carried both shapes: the snapshot wins).
 *
 * `staff` is the one table whose old `created_by` / `updated_by` was a Clerk
 * user id (moved aside by migration 264): the name is resolved through
 * `gym_memberships (gym_id, user_id)`.
 *
 * The `*_by_membership_id` foreign keys are never dropped: they are the record
 * of who acted before the snapshot existed. Writers stop touching them.
 */
const TABLES = [
  'activity_types', 'calendar_events', 'centers', 'class_packages', 'exercises',
  'gym_holiday_hours', 'gym_operating_hours', 'gyms', 'member_nutrition_plans',
  'member_personal_goals', 'members', 'membership_plans', 'nutrition_goals',
  'nutrition_library_items', 'nutrition_plan_templates', 'payment_providers',
  'personal_goals', 'products', 'professional_services', 'spaces', 'tax_rates',
  'training_plan_templates', 'workout_templates', 'staff', 'themes',
  'gym_personal_goals',
];

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
      const fk = `${name}_by_membership_id`;
      if (!after.has(at) || !after.has(fk) || !after.has(`${name}_by`)) continue;
      await knex.raw(
        `UPDATE \`${table}\` t JOIN gym_memberships gm ON gm.id = t.\`${fk}\`
            SET t.\`${name}_by\` = gm.name
          WHERE t.\`${name}_by\` IS NULL AND gm.name IS NOT NULL AND gm.name <> ''`);
    }
  }

  // staff: the previous created_by / updated_by were Clerk user ids.
  for (const [target, source] of [
    ['created_by', 'created_by_clerk_user_id'],
    ['modified_by', 'modified_by_clerk_user_id'],
  ]) {
    await knex.raw(
      `UPDATE staff s JOIN gym_memberships gm ON gm.user_id = s.\`${source}\` AND gm.gym_id = s.gym_id
          SET s.\`${target}\` = gm.name
        WHERE s.\`${target}\` IS NULL AND gm.name IS NOT NULL AND gm.name <> ''`);
  }
};

// Lossy by nature (the actor type is gone and several columns were backfilled
// from a membership that may no longer exist): nothing to restore faithfully.
exports.down = async function down() {};
