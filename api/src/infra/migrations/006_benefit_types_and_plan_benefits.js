/**
 * P1.4 (#8): membership plan benefits.
 * benefit_types is a global vocabulary (no gym_id) seeded with the full set;
 * two codes (waived_charge, class_package_credit) are seeded-but-inert until
 * their dependency tables ship (P1.6 charge_types, P3.1 class_packages).
 */

const SEED = [
  { code: 'priority_booking',    active: true },
  { code: 'free_locker',         active: true },
  { code: 'free_parking',        active: true },
  { code: 'waived_charge',       active: false }, // needs charge_types (P1.6 #10)
  { code: 'class_package_credit', active: false }, // needs class_packages (P3.1 #21)
];

exports.up = async (knex) => {
  await knex.schema.createTable('benefit_types', (t) => {
    t.increments('id').primary();
    t.string('code', 40).notNullable().unique();
    t.boolean('active').notNullable().defaultTo(true);
    t.datetime('created_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP'));
  });

  await knex('benefit_types').insert(SEED);

  await knex.schema.createTable('membership_plan_benefits', (t) => {
    t.increments('id').primary();
    t.specificType('gym_id', 'char(36)').notNullable()
      .references('id').inTable('gyms').onDelete('CASCADE');
    t.integer('membership_plan_id').unsigned().notNullable()
      .references('id').inTable('membership_plans').onDelete('CASCADE');
    t.integer('benefit_type_id').unsigned().notNullable()
      .references('id').inTable('benefit_types');
    t.integer('quantity');                    // NULL for flag benefits (priority_booking)
    t.integer('duration_days');               // NULL = no duration limit
    t.string('recurrence', 20);               // one-time (NULL) | monthly | yearly
    t.date('valid_from');                     // NULL = valid from plan start
    t.date('valid_to');                       // NULL = ongoing
    t.datetime('created_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP'));
    t.index(['membership_plan_id'], 'mpb_plan_index');
  });
  await knex.raw(
    "ALTER TABLE membership_plan_benefits ADD CONSTRAINT membership_plan_benefits_recurrence_check " +
    "CHECK (recurrence IS NULL OR recurrence IN ('monthly','yearly'))",
  );
};

exports.down = async (knex) => {
  await knex.raw('ALTER TABLE membership_plan_benefits DROP CHECK membership_plan_benefits_recurrence_check').catch(() => {});
  await knex.schema.dropTableIfExists('membership_plan_benefits');
  await knex.schema.dropTableIfExists('benefit_types');
};
