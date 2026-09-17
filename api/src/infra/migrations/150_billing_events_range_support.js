/**
 * #511 (stage 3 — Expanded detail + Billing Events endpoint).
 *
 * 1. `user_membership_promotions.revoked_at` (nullable DATETIME): stamped by
 *    `DELETE /user-memberships/:id/promotions/:promotionId` (see
 *    `membership-promotions.ts`) the moment a promotion is revoked. Without
 *    it there was no way to know *when* an applied-then-revoked promotion
 *    stopped affecting billing — `status='revoked'` alone doesn't carry a
 *    timestamp. The new Billing Events range calculation
 *    (`domain/assignedPlanBillingEvents.ts`) uses `[applied_at, revoked_at]`
 *    (revoked_at NULL meaning "still applied") to tag which persisted
 *    `billing_events` rows were affected by a promotion. Existing revoked
 *    rows are left with `revoked_at = NULL` — there is no way to reconstruct
 *    when they were revoked — so they're treated as covering their full
 *    `[applied_at, +inf)` window; this only widens (never narrows) the
 *    "promotion affected" tagging for pre-migration data, matching this
 *    ticket's "never exclude an applicable event" requirement over precision
 *    for data that predates the column.
 *
 * 2. `billing_events (user_membership_id, created_at)` composite index: the
 *    new `GET /user-memberships/:id/billing-events` endpoint fetches every
 *    ledger row for one membership ordered by `created_at` on every call.
 *    The existing `billing_events_membership_index` covers the equality
 *    filter but not the ordering; this composite index lets MySQL satisfy
 *    both the filter and the `ORDER BY` from the index directly.
 */
exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('user_membership_promotions', 'revoked_at'))) {
    await knex.schema.alterTable('user_membership_promotions', (t) => {
      t.dateTime('revoked_at').nullable();
    });
  }

  const beIndexes = await knex.raw('SHOW INDEX FROM billing_events WHERE Key_name = ?', ['billing_events_membership_created_index']);
  if (beIndexes[0].length === 0) {
    await knex.schema.alterTable('billing_events', (t) => {
      t.index(['user_membership_id', 'created_at'], 'billing_events_membership_created_index');
    });
  }
};

exports.down = async (knex) => {
  const beIndexes = await knex.raw('SHOW INDEX FROM billing_events WHERE Key_name = ?', ['billing_events_membership_created_index']);
  if (beIndexes[0].length > 0) {
    await knex.schema.alterTable('billing_events', (t) => {
      t.dropIndex(['user_membership_id', 'created_at'], 'billing_events_membership_created_index');
    });
  }

  if (await knex.schema.hasColumn('user_membership_promotions', 'revoked_at')) {
    await knex.schema.alterTable('user_membership_promotions', (t) => {
      t.dropColumn('revoked_at');
    });
  }
};
