/**
 * #321: Add weekdays JSON column to support multiple weekdays in a single weekly rule.
 * Before: weekly rules stored one weekday per row in the 'weekday' TINYINT column.
 * After:  weekly rules store an array (e.g. [1,3,5]) in 'weekdays' JSON column.
 *         The 'weekday' column is retained for monthly rules (unchanged).
 */
exports.up = async (knex) => {
  const hasColumn = await knex.schema.hasColumn('activity_type_schedule_rules', 'weekdays');
  if (!hasColumn) {
    await knex.schema.table('activity_type_schedule_rules', (t) => {
      t.json('weekdays').nullable();
    });
  }

  // Backfill existing weekly rules: copy single weekday into the new JSON array column
  await knex.raw(
    "UPDATE activity_type_schedule_rules SET weekdays = JSON_ARRAY(weekday) WHERE type = 'weekly' AND weekday IS NOT NULL AND weekdays IS NULL",
  );

  // Clear the legacy single-weekday column for weekly rules (monthly still uses it)
  await knex.raw(
    "UPDATE activity_type_schedule_rules SET weekday = NULL WHERE type = 'weekly'",
  );
};

exports.down = async (knex) => {
  // Restore single weekday from first element of weekdays array for weekly rules
  await knex.raw(
    "UPDATE activity_type_schedule_rules SET weekday = CAST(JSON_EXTRACT(weekdays, '$[0]') AS UNSIGNED) WHERE type = 'weekly' AND weekdays IS NOT NULL",
  );

  const hasColumn = await knex.schema.hasColumn('activity_type_schedule_rules', 'weekdays');
  if (hasColumn) {
    await knex.schema.table('activity_type_schedule_rules', (t) => {
      t.dropColumn('weekdays');
    });
  }
};
