// #484: Professional Services — a stable catalog of services a gym offers
// (Personal Training Individual, Group Class, ...), independent from the
// volatile Activities that later schedule them. `professional_services` holds
// the definition (global system rows with gym_id = NULL, or gym-owned custom
// rows); `gym_professional_services` holds the per-gym enable/disable state so
// a system service's activation in one gym never affects another.
exports.up = async (knex) => {
  if (!(await knex.schema.hasTable('professional_services'))) {
    await knex.schema.createTable('professional_services', (t) => {
      t.increments('id').primary();
      t.specificType('gym_id', 'char(36)').nullable()
        .references('id').inTable('gyms').onDelete('CASCADE');
      t.string('name', 150).notNullable();
      t.text('description').nullable();
      t.boolean('is_system').notNullable().defaultTo(false);
      t.string('system_key', 60).nullable().unique();
      t.datetime('created_at').notNullable().defaultTo(knex.raw('(UTC_TIMESTAMP())'));
      t.integer('created_by_membership_id').unsigned().nullable()
        .references('id').inTable('gym_memberships').onDelete('SET NULL');
      t.datetime('updated_at').nullable();
      t.integer('updated_by_membership_id').unsigned().nullable()
        .references('id').inTable('gym_memberships').onDelete('SET NULL');
      t.datetime('deleted_at').nullable();
      t.integer('deleted_by_membership_id').unsigned().nullable()
        .references('id').inTable('gym_memberships').onDelete('SET NULL');

      t.index(['gym_id'], 'professional_services_gym_id_index');
      t.index(['is_system'], 'professional_services_is_system_index');
      t.index(['deleted_at'], 'professional_services_deleted_at_index');
    });
  }

  if (!(await knex.schema.hasTable('gym_professional_services'))) {
    await knex.schema.createTable('gym_professional_services', (t) => {
      t.increments('id').primary();
      t.specificType('gym_id', 'char(36)').notNullable()
        .references('id').inTable('gyms').onDelete('CASCADE');
      t.integer('professional_service_id').unsigned().notNullable()
        .references('id').inTable('professional_services').onDelete('CASCADE');
      t.string('status', 20).notNullable().defaultTo('active');
      t.datetime('created_at').notNullable().defaultTo(knex.raw('(UTC_TIMESTAMP())'));
      t.integer('created_by_membership_id').unsigned().nullable()
        .references('id').inTable('gym_memberships').onDelete('SET NULL');
      t.datetime('updated_at').nullable();
      t.integer('updated_by_membership_id').unsigned().nullable()
        .references('id').inTable('gym_memberships').onDelete('SET NULL');

      // (gym_id, professional_service_id) is already the unique composite index below,
      // which also covers gym_id-only lookups — no separate single-column index needed.
      t.unique(['gym_id', 'professional_service_id'], 'gym_professional_services_gym_service_unique');
      t.index(['professional_service_id'], 'gym_professional_services_service_id_index');
    });
  }

  // Checked independently of hasTable() above: CREATE TABLE and ADD CONSTRAINT are two
  // separate non-transactional DDL statements, so a crash between them must not leave a
  // re-run permanently skipping the CHECK constraint (see migration 134 for precedent).
  const [[statusCheckExists]] = await knex.raw(
    `SELECT COUNT(*) AS cnt FROM information_schema.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'gym_professional_services'
       AND CONSTRAINT_NAME = 'chk_gym_professional_services_status'`,
  );
  if (statusCheckExists.cnt === 0) {
    await knex.raw(
      "ALTER TABLE gym_professional_services ADD CONSTRAINT chk_gym_professional_services_status " +
      "CHECK (status IN ('active','inactive'))",
    );
  }

  // Seed the global system Professional Services (gym_id = NULL).
  const SYSTEM_SERVICES = [
    ['Personal Training Individual', 'personal_training_individual'],
    ['Personal Training Duo', 'personal_training_duo'],
    ['Group Class', 'group_class'],
    ['Nutrition Coaching', 'nutrition_coaching'],
    ['Physiotherapy', 'physiotherapy'],
  ];
  for (const [name, systemKey] of SYSTEM_SERVICES) {
    await knex.raw(
      `INSERT INTO professional_services (gym_id, name, is_system, system_key, created_at)
       SELECT NULL, ?, 1, ?, UTC_TIMESTAMP()
       WHERE NOT EXISTS (SELECT 1 FROM professional_services WHERE system_key = ?)`,
      [name, systemKey, systemKey],
    );
  }

  // Backfill: every existing, non-deleted gym gets an active gym_professional_services
  // row for each system service. New gyms are seeded the same way in api/src/api/gyms.ts.
  await knex.raw(`
    INSERT IGNORE INTO gym_professional_services (gym_id, professional_service_id, status, created_at)
    SELECT g.id, ps.id, 'active', UTC_TIMESTAMP()
    FROM gyms g
    CROSS JOIN professional_services ps
    WHERE ps.is_system = 1 AND g.deleted_at IS NULL
  `);
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('gym_professional_services');
  await knex.schema.dropTableIfExists('professional_services');
};
