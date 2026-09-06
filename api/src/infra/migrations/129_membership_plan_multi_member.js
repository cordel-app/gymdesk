/**
 * #374: Support Multi-Member Membership Plans.
 *
 * Adds `member_limit` to membership_plans (1 | 2 | family) and a
 * `user_membership_members` join table recording every Member covered by a
 * Membership (the owner included, flagged via is_owner). Existing Memberships
 * are backfilled so their current owner becomes their sole covered member —
 * equivalent to member_limit='1', the new column's default — so no manual
 * migration is required for existing data.
 */
exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('membership_plans', 'member_limit'))) {
    await knex.schema.alterTable('membership_plans', (t) => {
      t.string('member_limit', 10).notNullable().defaultTo('1');
    });
  }
  await knex.raw('ALTER TABLE membership_plans DROP CHECK chk_mp_member_limit').catch(() => {});
  await knex.raw(
    "ALTER TABLE membership_plans ADD CONSTRAINT chk_mp_member_limit CHECK (member_limit IN ('1','2','family'))",
  );

  if (!(await knex.schema.hasTable('user_membership_members'))) {
    await knex.schema.createTable('user_membership_members', (t) => {
      t.increments('id').unsigned().primary();
      t.specificType('gym_id', 'char(36)').notNullable()
        .references('id').inTable('gyms').onDelete('CASCADE');
      t.integer('user_membership_id').unsigned().notNullable()
        .references('id').inTable('user_memberships').onDelete('CASCADE');
      t.integer('member_id').unsigned().notNullable()
        .references('id').inTable('members').onDelete('CASCADE');
      t.boolean('is_owner').notNullable().defaultTo(false);
      // Extra parens required here (unlike an ALTER ... ADD COLUMN default elsewhere in
      // this codebase): MySQL 8's CREATE TABLE column-default grammar only accepts a bare
      // function call for CURRENT_TIMESTAMP/NOW(); any other expression default, including
      // UTC_TIMESTAMP(), must be wrapped as DEFAULT (expr).
      t.datetime('created_at').notNullable().defaultTo(knex.raw('(UTC_TIMESTAMP())'));
      t.unique(['user_membership_id', 'member_id'], { indexName: 'umm_membership_member_unique' });
      t.index('gym_id', 'umm_gym_id_index');
    });
  }

  // Backfill: every existing Membership's owner becomes its sole covered Member.
  await knex.raw(`
    INSERT INTO user_membership_members (gym_id, user_membership_id, member_id, is_owner, created_at)
    SELECT um.gym_id, um.id, um.member_id, 1, UTC_TIMESTAMP()
    FROM user_memberships um
    WHERE NOT EXISTS (
      SELECT 1 FROM user_membership_members umm
      WHERE umm.user_membership_id = um.id AND umm.member_id = um.member_id
    )
  `);
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('user_membership_members');
  await knex.raw('ALTER TABLE membership_plans DROP CHECK chk_mp_member_limit').catch(() => {});
  if (await knex.schema.hasColumn('membership_plans', 'member_limit')) {
    await knex.schema.alterTable('membership_plans', (t) => t.dropColumn('member_limit'));
  }
};
