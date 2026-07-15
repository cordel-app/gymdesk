/**
 * #55: MemberTrainingPlan — assignment history, never overwritten. Per
 * ticket clarification, a member CAN have several active plans at once, so
 * there is deliberately no "one active per member" uniqueness constraint
 * here (unlike the legacy training_plans_one_active_per_weekday trick this
 * module replaces). ValidFrom/ValidTo are system-managed (stamped by the
 * API on status transitions), never client-supplied.
 *
 * members.member_training_plan_id is a "most-recently-assigned" convenience
 * pointer, updated on every new assignment — not an exclusivity guarantee.
 */
exports.up = async (knex) => {
  if (!(await knex.schema.hasTable('member_training_plans'))) {
    await knex.schema.createTable('member_training_plans', (t) => {
      t.increments('id').primary();
      t.specificType('gym_id', 'char(36)').notNullable()
        .references('id').inTable('gyms').onDelete('CASCADE');
      t.integer('member_id').unsigned().notNullable()
        .references('id').inTable('members').onDelete('CASCADE');
      t.integer('training_plan_id').unsigned().notNullable()
        .references('id').inTable('training_plans').onDelete('RESTRICT');
      t.integer('template_id').unsigned()
        .references('id').inTable('training_plan_templates').onDelete('SET NULL');
      t.string('name', 200);
      t.text('description');
      t.string('status', 20).notNullable().defaultTo('active');
      t.date('valid_from');
      t.date('valid_to');
      t.integer('assigned_by_membership_id').unsigned()
        .references('id').inTable('gym_memberships').onDelete('SET NULL');
      t.datetime('created_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP'));
      t.index(['gym_id', 'member_id'], 'mtp_gym_member_index');
    });
    await knex.raw(
      "ALTER TABLE member_training_plans ADD CONSTRAINT mtp_status_check " +
      "CHECK (status IN ('active','completed','cancelled'))",
    );
  }

  if (!(await knex.schema.hasColumn('members', 'member_training_plan_id'))) {
    await knex.schema.alterTable('members', (t) => {
      t.integer('member_training_plan_id').unsigned()
        .references('id').inTable('member_training_plans').onDelete('SET NULL');
    });
  }
};

exports.down = async (knex) => {
  await knex.schema.alterTable('members', (t) => {
    t.dropColumn('member_training_plan_id');
  });
  await knex.raw('ALTER TABLE member_training_plans DROP CHECK mtp_status_check').catch(() => {});
  await knex.schema.dropTableIfExists('member_training_plans');
};
