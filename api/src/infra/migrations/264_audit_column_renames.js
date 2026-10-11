/**
 * #1182 stage 2, step 1: free the names `created_by` / `modified_by` /
 * `deleted_by` for the plain-text actor snapshot (stage 1's mechanism,
 * `api/src/domain/auditActor.ts`) and settle the spelling of the timestamps.
 *
 * Structure only — no value changes:
 *
 *  - `members`, `membership_plans` and `exercises` carried `created_by` /
 *    `modified_by` / `deleted_by` as INTEGER foreign keys to `gym_memberships`.
 *    They are renamed to `*_by_membership_id` (the spelling the other fourteen
 *    FK-shaped tables already use). Foreign keys and their names are untouched;
 *    the columns are kept as the record of who acted before the text snapshot
 *    existed and are written by nothing from now on.
 *  - `professional_services` and `staff` called the modification pair
 *    `updated_*`; `calendar_events` had `updated_at` and no actor. All become
 *    `modified_*`.
 *  - `staff.created_by` / `updated_by` held a **Clerk user id**, not a display
 *    name. They move to `*_clerk_user_id` so the text columns can be added
 *    beside them (migration 265 resolves the name from them).
 *  - `calendar_events.modified_at` and `themes.modified_at` lose
 *    `ON UPDATE CURRENT_TIMESTAMP`: the timestamp and the actor must move
 *    together, and only the audit helpers write them now.
 */
async function hasColumn(knex, table, column) {
  const [rows] = await knex.raw(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    [table, column]);
  return rows.length > 0;
}

const COLUMN_RENAMES = [
  ['members', 'created_by', 'created_by_membership_id'],
  ['members', 'modified_by', 'modified_by_membership_id'],
  ['membership_plans', 'created_by', 'created_by_membership_id'],
  ['membership_plans', 'modified_by', 'modified_by_membership_id'],
  ['membership_plans', 'deleted_by', 'deleted_by_membership_id'],
  ['exercises', 'created_by', 'created_by_membership_id'],
  ['exercises', 'modified_by', 'modified_by_membership_id'],
  ['exercises', 'deleted_by', 'deleted_by_membership_id'],
  ['professional_services', 'updated_at', 'modified_at'],
  ['professional_services', 'updated_by_membership_id', 'modified_by_membership_id'],
  ['staff', 'updated_at', 'modified_at'],
  ['staff', 'created_by', 'created_by_clerk_user_id'],
  ['staff', 'updated_by', 'modified_by_clerk_user_id'],
];

exports.up = async function up(knex) {
  for (const [table, from, to] of COLUMN_RENAMES) {
    if (!(await hasColumn(knex, table, from)) || (await hasColumn(knex, table, to))) continue;
    await knex.raw(`ALTER TABLE \`${table}\` RENAME COLUMN \`${from}\` TO \`${to}\``);
  }

  if (await hasColumn(knex, 'calendar_events', 'updated_at')) {
    await knex.raw(
      `ALTER TABLE calendar_events
         CHANGE COLUMN updated_at modified_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP`);
  }
  await knex.raw(
    `ALTER TABLE themes MODIFY COLUMN modified_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP`);
};

exports.down = async function down(knex) {
  // The text snapshot columns of migration 265 take the names the integer FKs
  // used to have; 265's down() cannot tell which it added, so the reverse
  // rename must refuse rather than report a rollback that did nothing.
  for (const [table, from, to] of COLUMN_RENAMES) {
    if (['members', 'membership_plans', 'exercises'].includes(table)
        && (await hasColumn(knex, table, to)) && (await hasColumn(knex, table, from))) {
      throw new Error(
        `Cannot roll back 264: ${table}.${from} is now the text snapshot from migration 265 `
        + `(drop it first, then re-run the rollback).`);
    }
  }
  await knex.raw(
    `ALTER TABLE themes MODIFY COLUMN modified_at DATETIME NOT NULL
       DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP`);
  if (await hasColumn(knex, 'calendar_events', 'modified_at')
      && !(await hasColumn(knex, 'calendar_events', 'updated_at'))) {
    await knex.raw(
      `ALTER TABLE calendar_events
         CHANGE COLUMN modified_at updated_at DATETIME NOT NULL
         DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP`);
  }
  for (const [table, from, to] of [...COLUMN_RENAMES].reverse()) {
    if (!(await hasColumn(knex, table, to)) || (await hasColumn(knex, table, from))) continue;
    await knex.raw(`ALTER TABLE \`${table}\` RENAME COLUMN \`${to}\` TO \`${from}\``);
  }
};
