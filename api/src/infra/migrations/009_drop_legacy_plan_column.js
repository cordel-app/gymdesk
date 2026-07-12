/**
 * P1.7 (#11): drop the legacy `plan` text column from user_memberships.
 * P1.5's migration renamed subscriptions -> user_memberships and backfilled
 * membership_plan_id from the plan-name text; the column has been unused by
 * writes ever since (INSERTs set it to NULL and the last reader — me.ts's
 * COALESCE fallback — was removed in this same PR).
 *
 * Since abandoning it might leave a few historical rows whose plan name
 * couldn't be matched to a plan, we consider that string content
 * genuinely dead once the FK is present — the ledger + FK now carry the
 * information the string was standing in for.
 */
exports.up = async (knex) => {
  if (await knex.schema.hasColumn('user_memberships', 'plan')) {
    await knex.schema.alterTable('user_memberships', (t) => t.dropColumn('plan'));
  }
};

exports.down = async (knex) => {
  // Best-effort restore: the string was already lossy after P1.5 (rows with
  // an FK carried NULL). Re-adding it as nullable text preserves the schema
  // shape without pretending the data is recoverable.
  if (!(await knex.schema.hasColumn('user_memberships', 'plan'))) {
    await knex.schema.alterTable('user_memberships', (t) => t.string('plan', 255).nullable());
  }
};
