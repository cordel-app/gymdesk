/**
 * #213: plan_charge_benefits — per-plan charge type benefit configuration.
 * Each row defines what benefit (waive / % discount / fixed discount / none)
 * a plan provides on a specific charge type (membership_fee, registration_fee,
 * insurance_fee, class_package). One row per (plan, charge_type) pair.
 *
 * MySQL DDL is non-transactional, so every DDL step is independently guarded
 * to allow safe re-runs after a partial failure.
 */

exports.up = async (knex) => {
  if (!(await knex.schema.hasTable('plan_charge_benefits'))) {
    await knex.schema.createTable('plan_charge_benefits', (t) => {
      t.increments('id').primary();
      t.specificType('gym_id', 'char(36)').notNullable()
        .references('id').inTable('gyms').onDelete('CASCADE');
      t.integer('membership_plan_id').unsigned().notNullable()
        .references('id').inTable('membership_plans').onDelete('CASCADE');
      t.integer('charge_type_id').unsigned().notNullable()
        .references('id').inTable('charge_types');
      t.string('action', 30).notNullable().defaultTo('no_benefit');
      t.decimal('value', 10, 2).nullable();
      t.unique(['membership_plan_id', 'charge_type_id']);
    });
  }

  const hasConstraint = async (name) => {
    const [rows] = await knex.raw(`
      SELECT COUNT(*) AS cnt
      FROM information_schema.TABLE_CONSTRAINTS
      WHERE CONSTRAINT_SCHEMA = DATABASE()
        AND TABLE_NAME        = 'plan_charge_benefits'
        AND CONSTRAINT_NAME   = ?
    `, [name]);
    return Number(rows[0].cnt) > 0;
  };

  if (!(await hasConstraint('chk_pcb_action'))) {
    await knex.raw(`
      ALTER TABLE plan_charge_benefits
        ADD CONSTRAINT chk_pcb_action
        CHECK (action IN ('no_benefit','waive','percentage_discount','fixed_discount'))
    `);
  }

  if (!(await hasConstraint('chk_pcb_value'))) {
    await knex.raw(`
      ALTER TABLE plan_charge_benefits
        ADD CONSTRAINT chk_pcb_value
        CHECK (
          action IN ('no_benefit','waive')
          OR (action IN ('percentage_discount','fixed_discount') AND value IS NOT NULL)
        )
    `);
  }
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('plan_charge_benefits');
};
