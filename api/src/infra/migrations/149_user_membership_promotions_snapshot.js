/**
 * #511 (stage 2 — Assigned Plans historical promotion accuracy).
 *
 * `user_membership_promotions` today stores only a `promotion_id` FK, so
 * later renaming a promotion, changing its discount/benefit configuration,
 * or deactivating it silently rewrites what an already-applied Assigned Plan
 * appears to have received. This adds a nullable `snapshot` JSON column,
 * populated once at apply time (see `buildPromotionSnapshot` in
 * `api/src/api/membership-promotions.ts`) with the promotion's name,
 * description, stackable flag, campaign dates and its full set of charge /
 * period / included benefits as they existed at that moment.
 *
 * Existing rows are left with `snapshot = NULL` — the API falls back to a
 * live join against `promotions`/`promotion_charge_benefits`/
 * `promotion_period_benefits`/`promotion_included_benefits` for those
 * (pre-existing) applied promotions, since there is no way to reconstruct
 * what their configuration looked like at the (unrecorded) time they were
 * applied.
 *
 * No `.after(...)` position is specified — appending the column (like
 * sibling migrations 130/148) keeps this eligible for MySQL 8's
 * ALGORITHM=INSTANT regardless of exact patch version, unlike an
 * arbitrary-position ADD COLUMN (INSTANT-at-position needs >= 8.0.29).
 */
exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('user_membership_promotions', 'snapshot'))) {
    await knex.schema.alterTable('user_membership_promotions', (t) => {
      t.json('snapshot').nullable();
    });
  }
};

exports.down = async (knex) => {
  if (await knex.schema.hasColumn('user_membership_promotions', 'snapshot')) {
    await knex.schema.alterTable('user_membership_promotions', (t) => {
      t.dropColumn('snapshot');
    });
  }
};
