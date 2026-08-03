/**
 * Replaces promotion_charge_benefits.(charge_type_id + action_type_id) with
 * (gym_charge_id → gym_charges, action VARCHAR(30)).
 *
 * action_type_id mapping (from action_types table):
 *   1 = waive, 2 = percentage_discount, 3 = fixed_discount
 *
 * Rows that cannot be mapped to a gym_charges entry are deleted.
 * Depends on migration 090 (gym_charges) and 091 (plan_charge_benefits pattern).
 */
exports.up = async (knex) => {
  const hasGymChargeId = await knex.schema.hasColumn('promotion_charge_benefits', 'gym_charge_id');
  if (hasGymChargeId) return;

  // Step 1: Add new columns as nullable
  await knex.schema.alterTable('promotion_charge_benefits', (t) => {
    t.integer('gym_charge_id').unsigned().nullable().after('promotion_id');
  });
  await knex.schema.alterTable('promotion_charge_benefits', (t) => {
    t.string('action', 30).nullable().after('gym_charge_id');
  });

  // Step 2: Backfill gym_charge_id and action from existing data
  await knex.raw(`
    UPDATE promotion_charge_benefits pcb
    JOIN gym_charges gc ON gc.gym_id = pcb.gym_id AND gc.charge_type_id = pcb.charge_type_id
    JOIN action_types at ON at.id = pcb.action_type_id
    SET pcb.gym_charge_id = gc.id, pcb.action = at.code
  `);

  // Step 3: Remove rows that could not be mapped
  await knex.raw('DELETE FROM promotion_charge_benefits WHERE gym_charge_id IS NULL');

  // Step 4: Alter new columns to NOT NULL
  await knex.raw('ALTER TABLE promotion_charge_benefits MODIFY COLUMN `gym_charge_id` INT UNSIGNED NOT NULL');
  await knex.raw("ALTER TABLE promotion_charge_benefits MODIFY COLUMN `action` VARCHAR(30) NOT NULL DEFAULT 'no_benefit'");

  // Step 5: Add FK on gym_charge_id
  await knex.raw(`
    ALTER TABLE promotion_charge_benefits
    ADD CONSTRAINT \`prcb_gym_charge_id_foreign\`
    FOREIGN KEY (\`gym_charge_id\`) REFERENCES \`gym_charges\` (\`id\`) ON DELETE CASCADE
  `);

  // Step 6: Drop old FK constraints (known names from migration 020)
  await knex.raw('ALTER TABLE promotion_charge_benefits DROP FOREIGN KEY `promotion_charge_benefits_action_type_id_foreign`');
  await knex.raw('ALTER TABLE promotion_charge_benefits DROP FOREIGN KEY `promotion_charge_benefits_charge_type_id_foreign`');

  // Step 7: Drop old columns (also drops their supporting indexes)
  await knex.schema.alterTable('promotion_charge_benefits', (t) => {
    t.dropColumn('action_type_id');
    t.dropColumn('charge_type_id');
  });

  // Step 8: Add UNIQUE (promotion_id, gym_charge_id)
  await knex.raw(`
    ALTER TABLE promotion_charge_benefits
    ADD CONSTRAINT \`prcb_promotion_gym_charge_unique\`
    UNIQUE (\`promotion_id\`, \`gym_charge_id\`)
  `);

  // Step 9: Add CHECK on action
  await knex.raw(`
    ALTER TABLE promotion_charge_benefits
    ADD CONSTRAINT \`chk_prcb_action\`
    CHECK (\`action\` IN ('no_benefit','waive','percentage_discount','fixed_discount'))
  `);
};

exports.down = async (knex) => {
  const hasChargeTypeId = await knex.schema.hasColumn('promotion_charge_benefits', 'charge_type_id');
  if (hasChargeTypeId) return;

  await knex('promotion_charge_benefits').delete();

  await knex.raw('ALTER TABLE promotion_charge_benefits DROP INDEX `prcb_promotion_gym_charge_unique`');
  await knex.raw('ALTER TABLE promotion_charge_benefits DROP FOREIGN KEY `prcb_gym_charge_id_foreign`');

  await knex.schema.alterTable('promotion_charge_benefits', (t) => {
    t.dropColumn('gym_charge_id');
    t.dropColumn('action');
  });

  await knex.schema.alterTable('promotion_charge_benefits', (t) => {
    t.integer('charge_type_id').unsigned().notNullable()
      .references('id').inTable('charge_types')
      .after('promotion_id');
    t.integer('action_type_id').unsigned().notNullable()
      .references('id').inTable('action_types')
      .after('charge_type_id');
  });
};
