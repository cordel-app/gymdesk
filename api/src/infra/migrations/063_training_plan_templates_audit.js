/**
 * #73: Add modified_by_membership_id and deleted_by_membership_id audit
 * columns to training_plan_templates, mirroring the membership_plans pattern.
 */
exports.up = async (knex) => {
  const cols = {
    modified_by_membership_id: 'INT UNSIGNED NULL',
    deleted_by_membership_id:  'INT UNSIGNED NULL',
  };
  for (const [col, def] of Object.entries(cols)) {
    if (!(await knex.schema.hasColumn('training_plan_templates', col))) {
      await knex.raw(`ALTER TABLE training_plan_templates ADD COLUMN ${col} ${def}`);
    }
  }

  await knex.raw(`
    ALTER TABLE training_plan_templates
      ADD CONSTRAINT tpt_modified_by_fk FOREIGN KEY (modified_by_membership_id) REFERENCES gym_memberships(id) ON DELETE SET NULL,
      ADD CONSTRAINT tpt_deleted_by_fk  FOREIGN KEY (deleted_by_membership_id)  REFERENCES gym_memberships(id) ON DELETE SET NULL
  `).catch(() => {});
};

exports.down = async (knex) => {
  await knex.raw('ALTER TABLE training_plan_templates DROP FOREIGN KEY tpt_modified_by_fk').catch(() => {});
  await knex.raw('ALTER TABLE training_plan_templates DROP FOREIGN KEY tpt_deleted_by_fk').catch(() => {});
  for (const col of ['modified_by_membership_id', 'deleted_by_membership_id']) {
    if (await knex.schema.hasColumn('training_plan_templates', col)) {
      await knex.schema.alterTable('training_plan_templates', (t) => t.dropColumn(col));
    }
  }
};
