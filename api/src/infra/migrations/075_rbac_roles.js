/**
 * #156: Expand gym_memberships.role to support granular RBAC roles.
 *
 * Renames:
 *   coach  → trainer_performance
 *   staff  → front_desk
 *
 * Adds:
 *   trainer_perf_nutrition, accountant, nutritionist
 *
 * The CHECK constraint is dropped and recreated with the full new set.
 */

const NEW_ROLES = [
  'admin',
  'trainer_performance',
  'trainer_perf_nutrition',
  'front_desk',
  'accountant',
  'nutritionist',
  'member',
];

const OLD_ROLES = ['admin', 'coach', 'staff', 'member'];

async function constraintExists(knex) {
  const [rows] = await knex.raw(
    `SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE()
       AND TABLE_NAME = 'gym_memberships'
       AND CONSTRAINT_NAME = 'gym_memberships_role_check'
       AND CONSTRAINT_TYPE = 'CHECK'`,
  );
  return rows.length > 0;
}

exports.up = async (knex) => {
  // Drop constraint first so UPDATE can accept new role values; guard for re-run safety.
  if (await constraintExists(knex)) {
    await knex.raw('ALTER TABLE gym_memberships DROP CHECK gym_memberships_role_check');
  }

  // Rename existing rows to new role values.
  await knex.raw(`UPDATE gym_memberships SET role = 'trainer_performance' WHERE role = 'coach'`);
  await knex.raw(`UPDATE gym_memberships SET role = 'front_desk' WHERE role = 'staff'`);

  // Recreate constraint with the full new set; guard for re-run safety.
  if (!(await constraintExists(knex))) {
    await knex.raw(
      `ALTER TABLE gym_memberships ADD CONSTRAINT gym_memberships_role_check CHECK (role IN (${NEW_ROLES.map(() => '?').join(',')}))`,
      NEW_ROLES,
    );
  }
};

exports.down = async (knex) => {
  // Drop new constraint first so UPDATE can accept old role values; guard for re-run safety.
  if (await constraintExists(knex)) {
    await knex.raw('ALTER TABLE gym_memberships DROP CHECK gym_memberships_role_check');
  }

  // Remap back to old values (best-effort — new roles not in old set become 'staff').
  await knex.raw(`UPDATE gym_memberships SET role = 'coach' WHERE role = 'trainer_performance'`);
  await knex.raw(`UPDATE gym_memberships SET role = 'staff' WHERE role = 'trainer_perf_nutrition'`);
  await knex.raw(`UPDATE gym_memberships SET role = 'staff' WHERE role = 'front_desk'`);
  await knex.raw(`UPDATE gym_memberships SET role = 'staff' WHERE role = 'accountant'`);
  await knex.raw(`UPDATE gym_memberships SET role = 'staff' WHERE role = 'nutritionist'`);

  // Restore old constraint; guard for re-run safety.
  if (!(await constraintExists(knex))) {
    await knex.raw(
      `ALTER TABLE gym_memberships ADD CONSTRAINT gym_memberships_role_check CHECK (role IN (${OLD_ROLES.map(() => '?').join(',')}))`,
      OLD_ROLES,
    );
  }
};
