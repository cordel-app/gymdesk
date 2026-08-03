/**
 * Replaces plan_charge_benefits.charge_type_id (→ charge_types) with
 * gym_charge_id (→ gym_charges), so benefits are scoped to per-gym charges.
 *
 * Depends on migration 090 (gym_charges table with gym-scoped rows per charge_type).
 * The backfill join is: gym_charges WHERE gym_id = pcb.gym_id AND charge_type_id = pcb.charge_type_id.
 * Rows that cannot be mapped are deleted (orphaned benefits referencing a charge type
 * that has no gym_charges entry for that gym).
 *
 * Each step is individually guarded so partial runs can be safely retried.
 */
exports.up = async (knex) => {
  // Top-level guard: if charge_type_id is gone, migration is complete
  const hasChargeTypeId = await knex.schema.hasColumn('plan_charge_benefits', 'charge_type_id');
  if (!hasChargeTypeId) return;

  // Step 1: Add gym_charge_id as nullable if not already added (partial run guard)
  const hasGymChargeId = await knex.schema.hasColumn('plan_charge_benefits', 'gym_charge_id');
  if (!hasGymChargeId) {
    await knex.schema.alterTable('plan_charge_benefits', (t) => {
      t.integer('gym_charge_id').unsigned().nullable().after('membership_plan_id');
    });
  }

  // Step 2: Backfill (safe to re-run: WHERE gym_charge_id IS NULL)
  await knex.raw(`
    UPDATE plan_charge_benefits pcb
    JOIN gym_charges gc ON gc.gym_id = pcb.gym_id AND gc.charge_type_id = pcb.charge_type_id
    SET pcb.gym_charge_id = gc.id
    WHERE pcb.gym_charge_id IS NULL
  `);

  // Step 3: Remove rows that could not be mapped
  await knex.raw('DELETE FROM plan_charge_benefits WHERE gym_charge_id IS NULL');

  // Step 4: Alter to NOT NULL if still nullable
  const [[colInfo]] = await knex.raw(`
    SELECT IS_NULLABLE FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'plan_charge_benefits'
      AND COLUMN_NAME = 'gym_charge_id'
  `);
  if (colInfo.IS_NULLABLE === 'YES') {
    await knex.raw('ALTER TABLE plan_charge_benefits MODIFY COLUMN `gym_charge_id` INT UNSIGNED NOT NULL');
  }

  // Step 5: Add FK on gym_charge_id if not already added
  const [[newFkInfo]] = await knex.raw(`
    SELECT COUNT(*) AS cnt FROM information_schema.TABLE_CONSTRAINTS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'plan_charge_benefits'
      AND CONSTRAINT_NAME = 'pcb_gym_charge_id_foreign'
  `);
  if (newFkInfo.cnt === 0) {
    await knex.raw(`
      ALTER TABLE plan_charge_benefits
      ADD CONSTRAINT \`pcb_gym_charge_id_foreign\`
      FOREIGN KEY (\`gym_charge_id\`) REFERENCES \`gym_charges\` (\`id\`) ON DELETE CASCADE
    `);
  }

  // Step 6: Drop old FK on charge_type_id (if constraint still exists)
  const [[oldFkInfo]] = await knex.raw(`
    SELECT COUNT(*) AS cnt FROM information_schema.TABLE_CONSTRAINTS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'plan_charge_benefits'
      AND CONSTRAINT_NAME = 'plan_charge_benefits_charge_type_id_foreign'
      AND CONSTRAINT_TYPE = 'FOREIGN KEY'
  `);
  if (oldFkInfo.cnt > 0) {
    await knex.raw('ALTER TABLE plan_charge_benefits DROP FOREIGN KEY `plan_charge_benefits_charge_type_id_foreign`');
  }

  // Step 7: Atomically drop old UNIQUE and add new one in a single ALTER.
  // The old UNIQUE on (membership_plan_id, charge_type_id) may be serving as the
  // supporting index for the membership_plan_id FK — adding the replacement first
  // lets MySQL accept the drop. Check if old UNIQUE still exists.
  const [[oldUqInfo]] = await knex.raw(`
    SELECT COUNT(*) AS cnt FROM information_schema.TABLE_CONSTRAINTS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'plan_charge_benefits'
      AND CONSTRAINT_NAME = 'plan_charge_benefits_membership_plan_id_charge_type_id_unique'
  `);
  const [[newUqInfo]] = await knex.raw(`
    SELECT COUNT(*) AS cnt FROM information_schema.TABLE_CONSTRAINTS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'plan_charge_benefits'
      AND CONSTRAINT_NAME = 'pcb_plan_gym_charge_unique'
  `);

  if (oldUqInfo.cnt > 0 && newUqInfo.cnt === 0) {
    await knex.raw(`
      ALTER TABLE plan_charge_benefits
        DROP INDEX \`plan_charge_benefits_membership_plan_id_charge_type_id_unique\`,
        ADD CONSTRAINT \`pcb_plan_gym_charge_unique\` UNIQUE (\`membership_plan_id\`, \`gym_charge_id\`)
    `);
  } else if (oldUqInfo.cnt > 0) {
    await knex.raw('ALTER TABLE plan_charge_benefits DROP INDEX `plan_charge_benefits_membership_plan_id_charge_type_id_unique`');
  } else if (newUqInfo.cnt === 0) {
    await knex.raw(`
      ALTER TABLE plan_charge_benefits
      ADD CONSTRAINT \`pcb_plan_gym_charge_unique\` UNIQUE (\`membership_plan_id\`, \`gym_charge_id\`)
    `);
  }

  // Step 8: Drop any orphaned index on charge_type_id (index may remain after FK drop)
  const [[orphanIdxInfo]] = await knex.raw(`
    SELECT COUNT(*) AS cnt FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'plan_charge_benefits'
      AND INDEX_NAME = 'plan_charge_benefits_charge_type_id_foreign'
  `);
  if (orphanIdxInfo.cnt > 0) {
    await knex.raw('ALTER TABLE plan_charge_benefits DROP INDEX `plan_charge_benefits_charge_type_id_foreign`');
  }

  // Step 9: Drop the old column
  await knex.schema.alterTable('plan_charge_benefits', (t) => {
    t.dropColumn('charge_type_id');
  });
};

exports.down = async (knex) => {
  const hasChargeTypeId = await knex.schema.hasColumn('plan_charge_benefits', 'charge_type_id');
  if (hasChargeTypeId) return;

  await knex('plan_charge_benefits').delete();

  const [[newUqInfo]] = await knex.raw(`
    SELECT COUNT(*) AS cnt FROM information_schema.TABLE_CONSTRAINTS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'plan_charge_benefits'
      AND CONSTRAINT_NAME = 'pcb_plan_gym_charge_unique'
  `);
  if (newUqInfo.cnt > 0) {
    await knex.raw('ALTER TABLE plan_charge_benefits DROP INDEX `pcb_plan_gym_charge_unique`');
  }

  const [[fkInfo]] = await knex.raw(`
    SELECT COUNT(*) AS cnt FROM information_schema.TABLE_CONSTRAINTS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'plan_charge_benefits'
      AND CONSTRAINT_NAME = 'pcb_gym_charge_id_foreign'
  `);
  if (fkInfo.cnt > 0) {
    await knex.raw('ALTER TABLE plan_charge_benefits DROP FOREIGN KEY `pcb_gym_charge_id_foreign`');
  }

  await knex.schema.alterTable('plan_charge_benefits', (t) => {
    t.dropColumn('gym_charge_id');
  });

  await knex.schema.alterTable('plan_charge_benefits', (t) => {
    t.integer('charge_type_id').unsigned().notNullable()
      .references('id').inTable('charge_types')
      .after('membership_plan_id');
  });

  await knex.raw('ALTER TABLE plan_charge_benefits ADD UNIQUE (`membership_plan_id`, `charge_type_id`)');
};
