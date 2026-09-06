/**
 * #372: track who last extended a package's expiration date, and when.
 * class_package_transactions stays the credit ledger (amount CHECK IN (-1,1));
 * expiration changes aren't credit movements, so they get their own audit
 * columns here, mirroring the members/tax_rates modified_at/modified_by pattern.
 */

exports.up = async (knex) => {
  const hasModifiedAt = await knex.schema.hasColumn('user_class_packages', 'modified_at');
  const hasModifiedBy = await knex.schema.hasColumn('user_class_packages', 'modified_by_membership_id');

  await knex.schema.alterTable('user_class_packages', (t) => {
    if (!hasModifiedAt) {
      t.datetime('modified_at').nullable();
    }
    if (!hasModifiedBy) {
      t.integer('modified_by_membership_id').unsigned().nullable()
        .references('id').inTable('gym_memberships').onDelete('SET NULL')
        .withKeyName('fk_ucp_modified_by_membership');
    }
  });
};

exports.down = async (knex) => {
  const hasModifiedAt = await knex.schema.hasColumn('user_class_packages', 'modified_at');
  const hasModifiedBy = await knex.schema.hasColumn('user_class_packages', 'modified_by_membership_id');

  await knex.schema.alterTable('user_class_packages', (t) => {
    if (hasModifiedBy) { t.dropForeign(['modified_by_membership_id'], 'fk_ucp_modified_by_membership'); t.dropColumn('modified_by_membership_id'); }
    if (hasModifiedAt) { t.dropColumn('modified_at'); }
  });
};
