/**
 * #2363: `members.membership_plan_id` (the legacy "Fare", migration 002/004) is
 * dropped. A Member's plans are Assigned Plans (`user_memberships`) and
 * ProductSets; nothing wrote the column but the Add Member form and nothing
 * read it but the Members list's retired Fare label. Re-entrant.
 */
const fkNames = async (knex) => {
  const [rows] = await knex.raw(
    `SELECT CONSTRAINT_NAME AS name FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'members'
        AND COLUMN_NAME = 'membership_plan_id' AND REFERENCED_TABLE_NAME IS NOT NULL`);
  return rows.map((r) => r.name);
};
const hasColumn = async (knex) => {
  const [rows] = await knex.raw(
    `SELECT 1 FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'members' AND COLUMN_NAME = 'membership_plan_id' LIMIT 1`);
  return rows.length > 0;
};

exports.up = async (knex) => {
  if (!(await hasColumn(knex))) return;
  for (const name of await fkNames(knex)) {
    await knex.raw(`ALTER TABLE members DROP FOREIGN KEY \`${name}\``);
  }
  // Dropping the column drops any index that covers only it.
  await knex.raw('ALTER TABLE members DROP COLUMN membership_plan_id');
};

exports.down = async (knex) => {
  if (await hasColumn(knex)) return;
  await knex.raw(
    `ALTER TABLE members ADD COLUMN membership_plan_id INT UNSIGNED NULL,
       ADD CONSTRAINT fk_members_membership_plan FOREIGN KEY (membership_plan_id) REFERENCES membership_plans (id)`);
};
