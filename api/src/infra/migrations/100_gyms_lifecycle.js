/**
 * #228: Add lifecycle and audit columns to the gyms table.
 * Enables soft-delete, status tracking, and full audit visibility
 * for the Gyms Management page UX redesign.
 */
exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('gyms', 'description'))) {
    await knex.schema.alterTable('gyms', (t) => {
      t.text('description').nullable();
    });
  }

  if (!(await knex.schema.hasColumn('gyms', 'status'))) {
    await knex.schema.alterTable('gyms', (t) => {
      t.string('status', 20).notNullable().defaultTo('active');
    });
  }

  const [chkRows] = await knex.raw(
    "SELECT 1 FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_NAME = 'chk_gyms_status'",
  );
  if (chkRows.length === 0) {
    await knex.raw(
      "ALTER TABLE gyms ADD CONSTRAINT chk_gyms_status CHECK (status IN ('active','inactive','deleted'))",
    );
  }

  if (!(await knex.schema.hasColumn('gyms', 'created_by_name'))) {
    await knex.schema.alterTable('gyms', (t) => {
      t.string('created_by_name', 255).nullable();
    });
  }

  if (!(await knex.schema.hasColumn('gyms', 'modified_at'))) {
    await knex.schema.alterTable('gyms', (t) => {
      t.datetime('modified_at').nullable();
      t.string('modified_by_name', 255).nullable();
    });
  }

  if (!(await knex.schema.hasColumn('gyms', 'deleted_at'))) {
    await knex.schema.alterTable('gyms', (t) => {
      t.datetime('deleted_at').nullable();
      t.string('deleted_by_name', 255).nullable();
    });
  }
};

exports.down = async (knex) => {
  const cols = ['deleted_by_name', 'deleted_at', 'modified_by_name', 'modified_at', 'created_by_name'];
  for (const col of cols) {
    if (await knex.schema.hasColumn('gyms', col)) {
      await knex.schema.alterTable('gyms', (t) => t.dropColumn(col));
    }
  }

  const [checkRows] = await knex.raw(
    "SELECT 1 FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_NAME = 'chk_gyms_status'",
  );
  if (checkRows.length > 0) {
    await knex.raw('ALTER TABLE gyms DROP CHECK chk_gyms_status');
  }
  if (await knex.schema.hasColumn('gyms', 'status')) {
    await knex.schema.alterTable('gyms', (t) => t.dropColumn('status'));
  }

  if (await knex.schema.hasColumn('gyms', 'description')) {
    await knex.schema.alterTable('gyms', (t) => t.dropColumn('description'));
  }
};
