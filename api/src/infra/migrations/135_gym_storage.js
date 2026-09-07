/**
 * #417 stage 1: track per-gym Cloudflare R2 storage initialization.
 * `storage_folder_prefix` is captured at initialize time (not recomputed from
 * the gym's current name) so already-created folder paths / image URLs stay
 * valid even if the gym is later renamed.
 */
exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('gyms', 'storage_folder_prefix'))) {
    await knex.schema.alterTable('gyms', (t) => {
      t.string('storage_folder_prefix', 255).nullable();
    });
  }

  if (!(await knex.schema.hasColumn('gyms', 'storage_initialized_at'))) {
    await knex.schema.alterTable('gyms', (t) => {
      t.datetime('storage_initialized_at').nullable();
    });
  }

  const [uniqRows] = await knex.raw(
    "SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'gyms' AND INDEX_NAME = 'uq_gyms_storage_folder_prefix'",
  );
  if (uniqRows.length === 0) {
    await knex.raw(
      'ALTER TABLE gyms ADD CONSTRAINT uq_gyms_storage_folder_prefix UNIQUE (storage_folder_prefix)',
    );
  }
};

exports.down = async (knex) => {
  const [uniqRows] = await knex.raw(
    "SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'gyms' AND INDEX_NAME = 'uq_gyms_storage_folder_prefix'",
  );
  if (uniqRows.length > 0) {
    await knex.raw('ALTER TABLE gyms DROP INDEX uq_gyms_storage_folder_prefix');
  }

  if (await knex.schema.hasColumn('gyms', 'storage_initialized_at')) {
    await knex.schema.alterTable('gyms', (t) => t.dropColumn('storage_initialized_at'));
  }

  if (await knex.schema.hasColumn('gyms', 'storage_folder_prefix')) {
    await knex.schema.alterTable('gyms', (t) => t.dropColumn('storage_folder_prefix'));
  }
};
