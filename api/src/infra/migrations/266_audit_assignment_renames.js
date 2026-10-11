/**
 * #1182 stage 3, step 1: settle the spelling of the assignment and lifecycle
 * tables' timestamps before migration 267 adds the plain-text snapshot.
 *
 *  - `gym_professional_services` and `calendar_event_series` said `updated_*`;
 *    they become `modified_*` (and drop `ON UPDATE CURRENT_TIMESTAMP` on the
 *    series: the actor and the timestamp move together, through the helpers).
 *  - `promotions` and `user_membership_promotions` had no modification
 *    timestamp at all. `modified_at` is added (NULL = never modified), written
 *    by the helpers; a Promotion application's modification is its revocation.
 *
 * Structure only — no value changes.
 */
async function hasColumn(knex, table, column) {
  const [rows] = await knex.raw(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    [table, column]);
  return rows.length > 0;
}

const RENAMES = [
  ['gym_professional_services', 'updated_at', 'modified_at'],
  ['gym_professional_services', 'updated_by_membership_id', 'modified_by_membership_id'],
];

exports.up = async function up(knex) {
  for (const [table, from, to] of RENAMES) {
    if (!(await hasColumn(knex, table, from)) || (await hasColumn(knex, table, to))) continue;
    await knex.raw(`ALTER TABLE \`${table}\` RENAME COLUMN \`${from}\` TO \`${to}\``);
  }
  if (await hasColumn(knex, 'calendar_event_series', 'updated_at')) {
    await knex.raw(
      `ALTER TABLE calendar_event_series
         CHANGE COLUMN updated_at modified_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP`);
  }
  for (const table of ['promotions', 'user_membership_promotions']) {
    if (!(await hasColumn(knex, table, 'modified_at'))) {
      await knex.raw(`ALTER TABLE \`${table}\` ADD COLUMN modified_at DATETIME NULL`);
    }
  }
};

exports.down = async function down(knex) {
  for (const table of ['promotions', 'user_membership_promotions']) {
    if (await hasColumn(knex, table, 'modified_at') && !(await hasColumn(knex, table, 'modified_by'))) {
      await knex.raw(`ALTER TABLE \`${table}\` DROP COLUMN modified_at`);
    }
  }
  if (await hasColumn(knex, 'calendar_event_series', 'modified_at')
      && !(await hasColumn(knex, 'calendar_event_series', 'updated_at'))) {
    await knex.raw(
      `ALTER TABLE calendar_event_series
         CHANGE COLUMN modified_at updated_at DATETIME NOT NULL
         DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP`);
  }
  for (const [table, from, to] of [...RENAMES].reverse()) {
    if (!(await hasColumn(knex, table, to)) || (await hasColumn(knex, table, from))) continue;
    await knex.raw(`ALTER TABLE \`${table}\` RENAME COLUMN \`${to}\` TO \`${from}\``);
  }
};
