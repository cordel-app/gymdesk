/** Add deleted_by_name to all recycle-bin entity tables so superadmin deletions
 *  (where gymMembershipId is null) and directly-granted users (where
 *  gym_memberships.name is null) are still identifiable by display name. */
exports.up = async (knex) => {
  const tables = [
    { table: 'membership_plans' },
    { table: 'promotions' },
    { table: 'centers' },
    { table: 'spaces' },
    { table: 'class_packages' },
    { table: 'exercises' },
    { table: 'workout_templates' },
    { table: 'training_plan_templates' },
    { table: 'nutrition_plan_templates' },
    { table: 'themes' },
  ];

  for (const { table } of tables) {
    const has = await knex.schema.hasColumn(table, 'deleted_by_name');
    if (!has) {
      await knex.schema.alterTable(table, (t) => {
        t.string('deleted_by_name', 255).nullable();
      });
    }
  }
};

exports.down = async (knex) => {
  const tables = [
    'membership_plans', 'promotions', 'centers', 'spaces', 'class_packages',
    'exercises', 'workout_templates', 'training_plan_templates',
    'nutrition_plan_templates', 'themes',
  ];
  for (const table of tables) {
    const has = await knex.schema.hasColumn(table, 'deleted_by_name');
    if (has) {
      await knex.schema.alterTable(table, (t) => t.dropColumn('deleted_by_name'));
    }
  }
};
