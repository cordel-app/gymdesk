/**
 * #413: Membership Plans — applicable tax
 *
 * `membership_plans.tax_rate_id` was already added (and backfilled to each gym's
 * system tax rate) in migration 112/113 (#311), but no `tax_behavior` column was
 * ever added alongside it, and no endpoint/UI surfaced either field. This adds
 * `tax_behavior`, mirroring the `gym_charges` column added in the same #311
 * migration, so Plans can compute price-including/excluding-tax the same way
 * Sellable Items already do.
 *
 * The column add and its CHECK constraint are guarded independently (rather than
 * one umbrella `hasColumn` check) so a retry after a partial failure (interrupted
 * deploy, lock timeout) can safely resume instead of silently skipping whatever
 * didn't finish — see 126_tax_rates_description_and_audit_actor.js.
 */

async function constraintExists(knex, name) {
  const [rows] = await knex.raw(
    `SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'membership_plans' AND CONSTRAINT_NAME = ?`,
    [name],
  );
  return rows.length > 0;
}

exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('membership_plans', 'tax_behavior'))) {
    await knex.schema.alterTable('membership_plans', (t) => {
      t.string('tax_behavior', 20).notNullable().defaultTo('inclusive');
    });
  }
  if (!(await constraintExists(knex, 'chk_membership_plans_tax_behavior'))) {
    await knex.raw(
      'ALTER TABLE membership_plans ADD CONSTRAINT chk_membership_plans_tax_behavior ' +
      "CHECK (tax_behavior IN ('inclusive','exclusive'))",
    );
  }
};

exports.down = async (knex) => {
  if (await constraintExists(knex, 'chk_membership_plans_tax_behavior')) {
    await knex.raw('ALTER TABLE membership_plans DROP CHECK chk_membership_plans_tax_behavior');
  }
  if (await knex.schema.hasColumn('membership_plans', 'tax_behavior')) {
    await knex.schema.alterTable('membership_plans', (t) => {
      t.dropColumn('tax_behavior');
    });
  }
};
