/**
 * #388: Tax description field + audit actor snapshot (staff vs superadmin)
 *
 * `created_by_membership_id`/`modified_by_membership_id` are null for superadmins
 * acting directly (no gym_memberships row for them), so joining to gym_memberships
 * for display silently shows nothing for superadmin-authored taxes. Snapshot the
 * actor's display name and type ('staff'/'superadmin') at write time instead,
 * mirroring the existing `deleted_by_name` immutable-snapshot column on this table.
 *
 * Each DDL statement and the backfill below is guarded independently (rather than
 * one umbrella `hasColumn` check) so a retry after a partial failure (interrupted
 * deploy, lock timeout) can safely resume instead of silently skipping whatever
 * didn't finish.
 */

async function constraintExists(knex, name) {
  const [rows] = await knex.raw(
    `SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'tax_rates' AND CONSTRAINT_NAME = ?`,
    [name],
  );
  return rows.length > 0;
}

exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('tax_rates', 'description'))) {
    await knex.schema.alterTable('tax_rates', (t) => {
      t.string('description', 500).nullable();
    });
  }

  if (!(await knex.schema.hasColumn('tax_rates', 'created_by_name'))) {
    await knex.schema.alterTable('tax_rates', (t) => {
      t.string('created_by_name', 200).nullable();
      t.string('created_by_type', 20).nullable();
      t.string('modified_by_name', 200).nullable();
      t.string('modified_by_type', 20).nullable();
    });
  }

  if (!(await constraintExists(knex, 'chk_tax_rates_created_by_type'))) {
    await knex.raw(
      "ALTER TABLE tax_rates ADD CONSTRAINT chk_tax_rates_created_by_type " +
      "CHECK (created_by_type IS NULL OR created_by_type IN ('staff','superadmin'))",
    );
  }
  if (!(await constraintExists(knex, 'chk_tax_rates_modified_by_type'))) {
    await knex.raw(
      "ALTER TABLE tax_rates ADD CONSTRAINT chk_tax_rates_modified_by_type " +
      "CHECK (modified_by_type IS NULL OR modified_by_type IN ('staff','superadmin'))",
    );
  }

  // Backfill: rows whose actor still resolves to a gym_memberships row were staff-created/modified.
  // Rows created by a superadmin acting directly (membership id already null) can't be reconstructed
  // and are left unattributed, same as before this migration. Scoped to `*_type IS NULL` so this is
  // safe to re-run (won't re-touch rows a previous partial run already backfilled) and won't overwrite
  // a value set by the application after this migration ran.
  await knex.raw(`
    UPDATE tax_rates tr
    JOIN gym_memberships gm ON gm.id = tr.created_by_membership_id AND gm.gym_id = tr.gym_id
    SET tr.created_by_name = gm.name, tr.created_by_type = 'staff'
    WHERE tr.created_by_membership_id IS NOT NULL AND tr.created_by_type IS NULL
  `);
  await knex.raw(`
    UPDATE tax_rates tr
    JOIN gym_memberships gm ON gm.id = tr.modified_by_membership_id AND gm.gym_id = tr.gym_id
    SET tr.modified_by_name = gm.name, tr.modified_by_type = 'staff'
    WHERE tr.modified_by_membership_id IS NOT NULL AND tr.modified_by_type IS NULL
  `);
};

exports.down = async (knex) => {
  if (await constraintExists(knex, 'chk_tax_rates_created_by_type')) {
    await knex.raw('ALTER TABLE tax_rates DROP CHECK chk_tax_rates_created_by_type');
  }
  if (await constraintExists(knex, 'chk_tax_rates_modified_by_type')) {
    await knex.raw('ALTER TABLE tax_rates DROP CHECK chk_tax_rates_modified_by_type');
  }
  if (await knex.schema.hasColumn('tax_rates', 'created_by_name')) {
    await knex.schema.alterTable('tax_rates', (t) => {
      t.dropColumn('created_by_name');
      t.dropColumn('created_by_type');
      t.dropColumn('modified_by_name');
      t.dropColumn('modified_by_type');
    });
  }
  if (await knex.schema.hasColumn('tax_rates', 'description')) {
    await knex.schema.alterTable('tax_rates', (t) => {
      t.dropColumn('description');
    });
  }
};
