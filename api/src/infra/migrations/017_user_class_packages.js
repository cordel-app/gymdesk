/**
 * P3.2 (#22): per-member class package instances + credit ledger.
 * expires_at is computed at assignment (purchased_at + validity_days) and
 * stored, not virtual — so the API can query "still-active" without joining
 * the catalog and, more importantly, so expiring an existing package doesn't
 * change once the admin edits the catalog's validity_days later.
 *
 * amount CHECK enforces per-row single-credit granularity (P3.3 uses -1/+1).
 */
exports.up = async (knex) => {
  if (!(await knex.schema.hasTable('user_class_packages'))) {
    await knex.schema.createTable('user_class_packages', (t) => {
      t.increments('id').primary();
      t.specificType('gym_id', 'char(36)').notNullable()
        .references('id').inTable('gyms').onDelete('CASCADE');
      t.integer('member_id').unsigned().notNullable()
        .references('id').inTable('members').onDelete('CASCADE');
      t.integer('class_package_id').unsigned().notNullable()
        .references('id').inTable('class_packages').onDelete('RESTRICT');
      t.datetime('purchased_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP'));
      t.date('expires_at').notNullable();
      t.integer('sessions_remaining').notNullable();
      t.string('status', 20).notNullable().defaultTo('active');
      t.datetime('created_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP'));
      t.index(['gym_id', 'member_id'], 'ucp_gym_member_index');
    });
    await knex.raw(
      "ALTER TABLE user_class_packages ADD CONSTRAINT user_class_packages_status_check " +
      "CHECK (status IN ('active','consumed','expired','cancelled'))",
    );
  }

  if (!(await knex.schema.hasTable('class_package_transactions'))) {
    await knex.schema.createTable('class_package_transactions', (t) => {
      t.increments('id').primary();
      t.specificType('gym_id', 'char(36)').notNullable()
        .references('id').inTable('gyms').onDelete('CASCADE');
      t.integer('user_class_package_id').unsigned().notNullable()
        .references('id').inTable('user_class_packages').onDelete('CASCADE');
      t.integer('booking_id').unsigned()
        .references('id').inTable('bookings').onDelete('SET NULL');
      t.integer('amount').notNullable();
      t.text('reason');
      t.string('actor_user_id', 64);
      t.datetime('created_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP'));
      t.index(['user_class_package_id'], 'cpt_package_index');
    });
    await knex.raw(
      "ALTER TABLE class_package_transactions ADD CONSTRAINT class_package_transactions_amount_check " +
      "CHECK (amount IN (-1, 1))",
    );
  }
};

exports.down = async (knex) => {
  await knex.raw('ALTER TABLE class_package_transactions DROP CHECK class_package_transactions_amount_check').catch(() => {});
  await knex.raw('ALTER TABLE user_class_packages DROP CHECK user_class_packages_status_check').catch(() => {});
  await knex.schema.dropTableIfExists('class_package_transactions');
  await knex.schema.dropTableIfExists('user_class_packages');
};
