/**
 * #215: Gym Charges Configuration
 *
 * 1. Extends charge_types with `name` and `is_gym_charge` flag.
 * 2. Seeds 4 new gym-charge types (2 already existed: registration_fee, insurance_fee).
 * 3. Creates gym_charges table — per-gym configuration of each charge type.
 * 4. Backfills existing gyms with one unavailable row per gym-charge type.
 */

const GYM_CHARGE_CODES = [
  { code: 'registration_fee',    name: 'Registration Fee' },
  { code: 'insurance_fee',       name: 'Insurance Fee' },
  { code: 'locker_rental',       name: 'Locker Rental' },
  { code: 'parking_fee',         name: 'Parking Fee' },
  { code: 'access_key',          name: 'Access Key' },
  { code: 'premium_fitness_app', name: 'Premium Fitness App' },
];

const OTHER_NAMES = {
  membership_fee: 'Membership Fee',
  class_package:  'Class Package',
};

exports.up = async (knex) => {
  // 1. Extend charge_types
  const hasName = await knex.schema.hasColumn('charge_types', 'name');
  if (!hasName) {
    await knex.schema.alterTable('charge_types', (t) => {
      t.string('name', 100).nullable().after('code');
      t.tinyint('is_gym_charge').notNullable().defaultTo(0).after('name');
    });

    // Backfill names for existing non-gym-charge types
    for (const [code, name] of Object.entries(OTHER_NAMES)) {
      await knex('charge_types').where({ code }).update({ name, is_gym_charge: 0 });
    }

    // Upsert the 6 gym-charge types (2 may already exist)
    for (const { code, name } of GYM_CHARGE_CODES) {
      const existing = await knex('charge_types').where({ code }).first();
      if (existing) {
        await knex('charge_types').where({ code }).update({ name, is_gym_charge: 1 });
      } else {
        await knex('charge_types').insert({ code, name, active: true, is_gym_charge: 1 });
      }
    }
  }

  // 2. Create gym_charges
  if (!(await knex.schema.hasTable('gym_charges'))) {
    await knex.schema.createTable('gym_charges', (t) => {
      t.increments('id').primary();
      t.specificType('gym_id', 'char(36)').notNullable()
        .references('id').inTable('gyms').onDelete('CASCADE');
      t.integer('charge_type_id').unsigned().notNullable()
        .references('id').inTable('charge_types').onDelete('CASCADE');
      t.string('description', 500).nullable();
      t.decimal('amount', 10, 2).nullable();
      t.string('currency', 10).notNullable().defaultTo('EUR');
      t.string('billing_frequency', 20).nullable();
      t.string('availability', 20).notNullable().defaultTo('unavailable');
      t.text('notes').nullable();
      t.datetime('created_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP'));
      t.integer('created_by_membership_id').unsigned().nullable()
        .references('id').inTable('gym_memberships').onDelete('SET NULL');
      t.datetime('modified_at').nullable();
      t.integer('modified_by_membership_id').unsigned().nullable()
        .references('id').inTable('gym_memberships').onDelete('SET NULL');
      t.unique(['gym_id', 'charge_type_id'], 'gym_charges_gym_charge_type_unique');
    });

    await knex.raw(
      'ALTER TABLE gym_charges ADD CONSTRAINT gym_charges_currency_check ' +
      "CHECK (currency IN ('EUR'))",
    );
    await knex.raw(
      'ALTER TABLE gym_charges ADD CONSTRAINT gym_charges_billing_frequency_check ' +
      "CHECK (billing_frequency IS NULL OR billing_frequency IN ('once','week','month','year'))",
    );
    await knex.raw(
      'ALTER TABLE gym_charges ADD CONSTRAINT gym_charges_availability_check ' +
      "CHECK (availability IN ('available','unavailable'))",
    );

    // 3. Backfill existing gyms
    await knex.raw(`
      INSERT IGNORE INTO gym_charges (gym_id, charge_type_id, created_at)
      SELECT g.id, ct.id, UTC_TIMESTAMP()
      FROM gyms g
      CROSS JOIN charge_types ct
      WHERE ct.is_gym_charge = 1
    `);
  }
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('gym_charges');

  await knex('charge_types').whereIn('code', [
    'locker_rental', 'parking_fee', 'access_key', 'premium_fitness_app',
  ]).delete();

  const hasName = await knex.schema.hasColumn('charge_types', 'name');
  if (hasName) {
    await knex.schema.alterTable('charge_types', (t) => {
      t.dropColumn('is_gym_charge');
      t.dropColumn('name');
    });
  }
};
