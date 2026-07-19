/**
 * #70: Replace binary status with lifecycle_status + enrollment_status, add soft-delete
 * and audit fields, drop legacy base_price and status columns.
 */
exports.up = async (knex) => {
  // Add new lifecycle / enrollment status columns
  if (!(await knex.schema.hasColumn('membership_plans', 'lifecycle_status'))) {
    await knex.schema.alterTable('membership_plans', (t) => {
      t.string('lifecycle_status', 20).notNullable().defaultTo('draft').after('description');
      t.string('enrollment_status', 20).notNullable().defaultTo('closed').after('lifecycle_status');
    });
  }

  // Add audit / soft-delete columns
  const cols = {
    created_by: "INT UNSIGNED NULL",
    modified_at: "DATETIME NULL",
    modified_by: "INT UNSIGNED NULL",
    deleted_at: "DATETIME NULL",
    deleted_by: "INT UNSIGNED NULL",
  };
  for (const [col, def] of Object.entries(cols)) {
    if (!(await knex.schema.hasColumn('membership_plans', col))) {
      await knex.raw(`ALTER TABLE membership_plans ADD COLUMN ${col} ${def}`);
    }
  }

  // FK constraints for audit columns (gym_memberships.id, SET NULL on delete)
  await knex.raw(`
    ALTER TABLE membership_plans
      ADD CONSTRAINT mp_created_by_fk  FOREIGN KEY (created_by)  REFERENCES gym_memberships(id) ON DELETE SET NULL,
      ADD CONSTRAINT mp_modified_by_fk FOREIGN KEY (modified_by) REFERENCES gym_memberships(id) ON DELETE SET NULL,
      ADD CONSTRAINT mp_deleted_by_fk  FOREIGN KEY (deleted_by)  REFERENCES gym_memberships(id) ON DELETE SET NULL
  `).catch(() => {}); // ignore if already exist

  // Data migration: map old status → new columns
  await knex.raw(`
    UPDATE membership_plans
    SET lifecycle_status  = 'active',
        enrollment_status = 'open'
    WHERE status = 'active'
  `).catch(() => {});
  await knex.raw(`
    UPDATE membership_plans
    SET lifecycle_status  = 'active',
        enrollment_status = 'closed'
    WHERE status = 'inactive'
  `).catch(() => {});

  // Drop old columns
  if (await knex.schema.hasColumn('membership_plans', 'status')) {
    await knex.schema.alterTable('membership_plans', (t) => t.dropColumn('status'));
  }
  if (await knex.schema.hasColumn('membership_plans', 'base_price')) {
    await knex.schema.alterTable('membership_plans', (t) => t.dropColumn('base_price'));
  }
};

exports.down = async (knex) => {
  // Restore status column and back-fill
  if (!(await knex.schema.hasColumn('membership_plans', 'status'))) {
    await knex.schema.alterTable('membership_plans', (t) => {
      t.string('status', 20).notNullable().defaultTo('active');
    });
    await knex.raw(`UPDATE membership_plans SET status = IF(enrollment_status = 'open', 'active', 'inactive')`);
  }

  // Restore base_price (nullable since data is lost)
  if (!(await knex.schema.hasColumn('membership_plans', 'base_price'))) {
    await knex.schema.alterTable('membership_plans', (t) => t.decimal('base_price', 10, 2).nullable());
  }

  // Drop audit columns
  await knex.raw('ALTER TABLE membership_plans DROP FOREIGN KEY mp_created_by_fk').catch(() => {});
  await knex.raw('ALTER TABLE membership_plans DROP FOREIGN KEY mp_modified_by_fk').catch(() => {});
  await knex.raw('ALTER TABLE membership_plans DROP FOREIGN KEY mp_deleted_by_fk').catch(() => {});
  for (const col of ['created_by', 'modified_at', 'modified_by', 'deleted_at', 'deleted_by', 'lifecycle_status', 'enrollment_status']) {
    if (await knex.schema.hasColumn('membership_plans', col)) {
      await knex.schema.alterTable('membership_plans', (t) => t.dropColumn(col));
    }
  }
};
