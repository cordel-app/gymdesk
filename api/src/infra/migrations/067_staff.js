/**
 * #123: Staff Management — new `staff` table for HR/employment data.
 *
 * Separate from `gym_memberships` (auth roles). A staff record stores rich
 * employment info and can optionally link to a gym_memberships row for future
 * auth-blocking of inactive employees.
 */

exports.up = async (knex) => {
  if (await knex.schema.hasTable('staff')) return;

  await knex.schema.createTable('staff', (t) => {
    t.increments('id').primary();
    t.specificType('gym_id', 'char(36)').notNullable()
      .references('id').inTable('gyms').onDelete('CASCADE');

    // Optional link to the auth identity
    t.integer('gym_membership_id').unsigned().nullable()
      .references('id').inTable('gym_memberships').onDelete('SET NULL');

    // General
    t.string('first_name', 100).notNullable();
    t.string('last_name', 100).notNullable();
    t.string('email', 255).notNullable();
    t.string('mobile_phone', 50).nullable();
    t.string('profile_photo_url', 500).nullable();
    t.date('date_of_birth').nullable();
    t.string('national_id', 100).nullable();

    // Employment
    t.string('profile', 80).notNullable();
    t.string('employment_status', 20).notNullable().defaultTo('active');
    t.string('current_status', 30).notNullable().defaultTo('available');
    t.date('hire_date').notNullable();
    t.date('contract_end_date').nullable();
    t.date('termination_date').nullable();
    t.integer('assigned_center_id').unsigned().nullable()
      .references('id').inTable('centers').onDelete('SET NULL');
    t.integer('direct_manager_id').unsigned().nullable()
      .references('id').inTable('staff').onDelete('SET NULL');
    t.string('employee_number', 50).nullable();

    // Contact
    t.string('company_email', 255).nullable();
    t.string('company_phone', 50).nullable();
    t.string('personal_phone', 50).nullable();
    t.string('emergency_contact', 100).nullable();
    t.string('emergency_phone', 50).nullable();

    // Schedule
    t.string('working_days', 50).nullable();   // CSV: "Mon,Tue,Wed,Thu,Fri"
    t.time('work_start_time').nullable();
    t.time('work_end_time').nullable();
    t.smallint('break_duration_minutes').unsigned().nullable();

    // Misc
    t.text('notes').nullable();

    // Soft delete + audit
    t.datetime('deleted_at').nullable();
    t.datetime('created_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP'));
    t.datetime('updated_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP'));
    t.string('created_by', 255).nullable();
    t.string('updated_by', 255).nullable();

    t.index(['gym_id'], 'staff_gym_index');
    t.index(['gym_id', 'employment_status'], 'staff_gym_employment_index');
    t.index(['assigned_center_id'], 'staff_center_index');
  });

  await knex.raw(
    `ALTER TABLE staff
       ADD CONSTRAINT staff_employment_status_check
         CHECK (employment_status IN ('active','inactive')),
       ADD CONSTRAINT staff_current_status_check
         CHECK (current_status IN ('available','on_vacation','sick_leave','maternity_leave','paternity_leave','training','suspended','other'))`,
  );
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('staff');
};
