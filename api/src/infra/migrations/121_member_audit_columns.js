/**
 * #346: Add audit columns to members table.
 * Adds: created_by, modified_at, modified_by for the Details view.
 */

exports.up = async (knex) => {
  const hasCreatedBy = await knex.schema.hasColumn('members', 'created_by');
  const hasModifiedAt = await knex.schema.hasColumn('members', 'modified_at');
  const hasModifiedBy = await knex.schema.hasColumn('members', 'modified_by');

  await knex.schema.alterTable('members', (t) => {
    if (!hasCreatedBy) {
      t.integer('created_by').unsigned().nullable()
        .references('id').inTable('gym_memberships').onDelete('SET NULL')
        .withKeyName('fk_members_created_by');
    }
    if (!hasModifiedAt) {
      t.datetime('modified_at').nullable();
    }
    if (!hasModifiedBy) {
      t.integer('modified_by').unsigned().nullable()
        .references('id').inTable('gym_memberships').onDelete('SET NULL')
        .withKeyName('fk_members_modified_by');
    }
  });
};

exports.down = async (knex) => {
  const hasCreatedBy = await knex.schema.hasColumn('members', 'created_by');
  const hasModifiedAt = await knex.schema.hasColumn('members', 'modified_at');
  const hasModifiedBy = await knex.schema.hasColumn('members', 'modified_by');

  await knex.schema.alterTable('members', (t) => {
    if (hasModifiedBy) { t.dropForeign('fk_members_modified_by'); t.dropColumn('modified_by'); }
    if (hasModifiedAt) { t.dropColumn('modified_at'); }
    if (hasCreatedBy)  { t.dropForeign('fk_members_created_by');  t.dropColumn('created_by');  }
  });
};
