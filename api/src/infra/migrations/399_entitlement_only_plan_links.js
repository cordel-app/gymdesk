/**
 * #2659 stage 3: a Product Set may link a plan snapshot **for entitlement only**.
 *
 * A Draft created for the owner (Add Membership Plan, `⋮ → Edit`, a clone of the
 * Active set) links the plan snapshot of each of the owner's
 * `active_cancel_at_period_end` assignments, so the Draft carries every plan the
 * member still holds. Such a link is the member's existing contract running to
 * its last paid day: it is never billed, never part of an initial charge, never
 * projected (so activating the set never re-opens the cancelled assignment) and
 * never the set's primary plan. `entitlement_only = 1` marks it; every reader
 * that bills, projects or edits a set's plans asks `entitlement_only = 0`.
 *
 * `NOT NULL DEFAULT 0` so every existing link keeps meaning what it meant.
 * `ADD COLUMN` with a default is INSTANT in MySQL 8; no CHECK (a TINYINT(1)
 * flag, written only as 0 or 1 by `linkCancellingPlans()`).
 */
exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('product_set_plan_snapshots', 'entitlement_only'))) {
    await knex.raw(
      'ALTER TABLE product_set_plan_snapshots ADD COLUMN entitlement_only TINYINT(1) NOT NULL DEFAULT 0');
  }
};

exports.down = async (knex) => {
  if (await knex.schema.hasColumn('product_set_plan_snapshots', 'entitlement_only')) {
    await knex.raw('DELETE FROM product_set_plan_snapshots WHERE entitlement_only = 1');
    await knex.raw('ALTER TABLE product_set_plan_snapshots DROP COLUMN entitlement_only');
  }
};
