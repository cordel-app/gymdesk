/**
 * #1325 PR 3 — the ProductSet is the only billing path.
 *
 * What this migration tightens:
 *
 *  1. A `status_changed` row — a membership status transition — is not a
 *     financial event any more (A4): the rows still in the ledger are moved into
 *     `audit_logs` (entity `user_membership`, action `status_change`) and
 *     deleted from `billing_events`, so the ledger holds money events only.
 *  2. `user_memberships.failed_attempts` / `last_failed_at` are dropped: #785's
 *     escalation counts the failed days of the *event* being charged
 *     (`scheduled-event-execution.ts`), and the surfaces that still report the
 *     pair derive it from the ledger (`domain/derivedBilling.ts`).
 *
 * Guard: a database that still holds **legacy** billing rows — an event with no
 * ProductSet that is neither a purchase nor a status transition, or an
 * assignment still on the retired assignment pass (`next_billing_date` set) —
 * refuses to migrate. Those rows belong to the pre-ProductSet model and are
 * removed by the approved development reset (`npm run billing:reset-dev`,
 * `.github/workflows/billing-reset-dev.yml`); this migration deletes nothing of
 * them itself, because deleting money records is the reset's explicitly
 * approved act and not a side effect of deploying.
 *
 * `next_billing_date` / `last_billed_at`, `billing_events.user_membership_id`,
 * the commercial columns of `user_memberships` and the CHECK that makes
 * `billing_events.product_set_id` NOT NULL except for a `product_purchase` go
 * in the next stage: the Admin's Save & Pay still writes the initial payment's
 * event before the ProductSet it will belong to exists (the commit imports it
 * and links the event), so the CHECK has to wait for that path to create its
 * Pending Payment version up front.
 */

const count = async (knex, sql, params = []) => {
  const rows = await knex.raw(sql, params);
  return Number(rows[0][0].n);
};

exports.up = async (knex) => {
  const legacyEvents = await count(
    knex,
    `SELECT COUNT(*) AS n FROM billing_events
      WHERE product_set_id IS NULL AND event_type NOT IN ('product_purchase', 'status_changed')`,
  );
  const legacyAssignments = await count(
    knex,
    'SELECT COUNT(*) AS n FROM user_memberships WHERE next_billing_date IS NOT NULL',
  );
  if (legacyEvents > 0 || legacyAssignments > 0) {
    throw new Error(
      `migration 252 refused: ${legacyEvents} legacy billing event(s) and ${legacyAssignments} `
      + 'assignment(s) still on the retired assignment pass. Run the approved development reset '
      + '(npm run billing:reset-dev) first — this migration never deletes money records itself.',
    );
  }

  // A4 — status transitions leave the ledger for the audit log. Copied first,
  // deleted after, in one statement each; `audit_logs` has no uniqueness on
  // these columns, so a re-run after a partial failure is guarded by the
  // SELECT below finding nothing left to copy.
  await knex.raw(
    `INSERT INTO audit_logs
       (gym_id, actor_user_id, actor_name, action, entity_type, entity_id, entity_name,
        previous_values, new_values, source, ip, user_agent, created_at)
     SELECT be.gym_id, be.actor_user_id, NULL, 'status_change', 'user_membership',
            CAST(be.user_membership_id AS CHAR), NULL,
            JSON_OBJECT('status', be.previous_status, 'member_id', be.member_id),
            JSON_OBJECT('status', be.new_status, 'member_id', be.member_id),
            be.source, NULL, NULL, be.created_at
       FROM billing_events be
      WHERE be.event_type = 'status_changed'`,
  );
  await knex.raw("DELETE FROM billing_events WHERE event_type = 'status_changed'");

  for (const column of ['failed_attempts', 'last_failed_at']) {
    if (await knex.schema.hasColumn('user_memberships', column)) {
      await knex.raw(`ALTER TABLE user_memberships DROP COLUMN ${column}`);
    }
  }
};

exports.down = async (knex) => {
  if (!(await knex.schema.hasColumn('user_memberships', 'failed_attempts'))) {
    await knex.raw(
      `ALTER TABLE user_memberships
         ADD COLUMN failed_attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
         ADD COLUMN last_failed_at DATETIME NULL`,
    );
  }
  // The status transitions copied into audit_logs are left there: they are a
  // true record either way, and the ledger rows cannot be reconstructed with
  // their original ids.
};
