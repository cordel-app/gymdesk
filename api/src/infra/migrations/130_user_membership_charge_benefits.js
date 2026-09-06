/**
 * #376: Assign Plan to Member(s) and Create Membership & Billing Events.
 *
 * Snapshots a Membership Plan's charge benefits (`plan_charge_benefits`) onto
 * the Membership at the moment it is instantiated, so a later edit/removal of
 * a Plan's benefits never retroactively changes a Membership that was already
 * granted them. `no_benefit` rows are never snapshotted — only a Membership's
 * actually-granted benefits (waive / percentage_discount / fixed_discount)
 * are recorded here.
 */
exports.up = async (knex) => {
  if (!(await knex.schema.hasTable('user_membership_charge_benefits'))) {
    await knex.schema.createTable('user_membership_charge_benefits', (t) => {
      t.increments('id').unsigned().primary();
      t.specificType('gym_id', 'char(36)').notNullable()
        .references('id').inTable('gyms').onDelete('CASCADE');
      t.integer('user_membership_id').unsigned().notNullable()
        .references('id').inTable('user_memberships').onDelete('CASCADE');
      t.integer('gym_charge_id').unsigned().notNullable()
        .references('id').inTable('gym_charges');
      t.string('action', 30).notNullable();
      t.decimal('value', 10, 2).nullable();
      t.datetime('created_at').notNullable().defaultTo(knex.raw('(UTC_TIMESTAMP())'));
      t.index(['user_membership_id'], 'umcb_membership_index');
    });
  }
  await knex.raw('ALTER TABLE user_membership_charge_benefits DROP CHECK chk_umcb_action').catch(() => {});
  await knex.raw(
    "ALTER TABLE user_membership_charge_benefits ADD CONSTRAINT chk_umcb_action " +
    "CHECK (action IN ('waive','percentage_discount','fixed_discount'))",
  );
};

exports.down = async (knex) => {
  await knex.raw('ALTER TABLE user_membership_charge_benefits DROP CHECK chk_umcb_action').catch(() => {});
  await knex.schema.dropTableIfExists('user_membership_charge_benefits');
};
