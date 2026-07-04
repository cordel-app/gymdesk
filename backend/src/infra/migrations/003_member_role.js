exports.up = async (knex) => {
  // Widen the allowed roles to include 'member' (MySQL: drop + re-add the named CHECK)
  await knex.raw('ALTER TABLE gym_memberships DROP CHECK gym_memberships_role_check');
  await knex.raw(
    "ALTER TABLE gym_memberships ADD CONSTRAINT gym_memberships_role_check CHECK (role IN ('admin','coach','staff','member'))",
  );

  await knex.schema.alterTable('members', (t) => {
    t.string('clerk_user_id', 255).unique();
  });
};

exports.down = async (knex) => {
  await knex.schema.alterTable('members', (t) => {
    t.dropColumn('clerk_user_id');
  });

  await knex.raw('ALTER TABLE gym_memberships DROP CHECK gym_memberships_role_check');
  await knex.raw(
    "ALTER TABLE gym_memberships ADD CONSTRAINT gym_memberships_role_check CHECK (role IN ('admin','coach','staff'))",
  );
};
