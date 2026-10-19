/**
 * #1694 stage 2 — remove the assigned Membership Plans that were cancelled
 * with no end date. Owner-approved hard delete (issue #1694 comments).
 *
 * Stage 1 (PR #1729) made every cancelling path stamp `ends_at`, so no
 * supported workflow creates a `cancelled` row with `ends_at IS NULL` any more.
 * The rows written before it read as *Open-ended* in the member's Past Plans.
 * Exactly those rows go: a cancelled assignment with an end date and every
 * other status are untouched.
 *
 * The two foreign keys onto `user_memberships` are the whole list of what a
 * delete could take with it:
 *
 *  - `payment_requests.user_membership_id` is `ON DELETE CASCADE`. A payment
 *    request is a money record, so it is **kept**: the column is nulled first
 *    (nullable since migration 228); the request still names its member and its
 *    Billing Event.
 *  - `product_sets.user_membership_id` is `ON DELETE SET NULL`, so the
 *    versions, their Billing Events and lines survive by themselves.
 *
 * `audit_logs` has no FK and keeps every row. Each deleted assignment gets one
 * audit row (`delete`, entity `user_membership`, source `system`) whose
 * `previous_values` is the row as it stood, so the cleanup is auditable.
 *
 * One transaction (knex's default for a migration): the rows are read under
 * `FOR UPDATE` and the migration fails if the delete removes a different
 * number. Re-running finds nothing and changes nothing. `down` is a no-op.
 *
 * No CHECK is added on `user_memberships`: that table carries none by decision
 * (migrations 174/189 — `ADD CONSTRAINT` rebuilds it under `ALGORITHM=COPY`),
 * so the guarantee is the writers' (stage 1).
 */

const MATCH = "um.status = 'cancelled' AND um.ends_at IS NULL";

/**
 * Returns `{ counted, deleted, detached }`. `gymIds` narrows it to those gyms —
 * the test suite's use, since other test files share the database; the
 * migration passes nothing and acts on every gym.
 */
async function deleteCancelledWithoutEndDate(knex, { gymIds } = {}) {
  if (gymIds && gymIds.length === 0) return { counted: 0, deleted: 0, detached: 0 };
  const scope = gymIds ? ` AND um.gym_id IN (${gymIds.map(() => '?').join(', ')})` : '';

  const [rows] = await knex.raw(
    `SELECT um.* FROM user_memberships um WHERE ${MATCH}${scope} ORDER BY um.id FOR UPDATE`,
    gymIds ?? [],
  );
  if (rows.length === 0) return { counted: 0, deleted: 0, detached: 0 };
  const ids = rows.map((r) => r.id);
  const idList = ids.map(() => '?').join(', ');

  // A version still in flight or active on a cancelled assignment is already
  // inconsistent; it survives unlinked (SET NULL), and is reported, not refused.
  const [[live]] = await knex.raw(
    `SELECT COUNT(*) AS n FROM product_sets
      WHERE user_membership_id IN (${idList}) AND status IN ('draft', 'pending_payment', 'active')`,
    ids,
  );
  if (Number(live.n) > 0) {
    console.warn(`migration 297: ${live.n} draft/pending/active ProductSet version(s) left unlinked`);
  }

  const [detach] = await knex.raw(
    `UPDATE payment_requests SET user_membership_id = NULL WHERE user_membership_id IN (${idList})`,
    ids,
  );

  for (const row of rows) {
    await knex.raw(
      `INSERT INTO audit_logs
         (gym_id, actor_user_id, actor_name, action, entity_type, entity_id, entity_name,
          previous_values, new_values, source, ip, user_agent, created_at)
       VALUES (?, NULL, 'System', 'delete', 'user_membership', ?, NULL, ?, ?, 'system', NULL, NULL, UTC_TIMESTAMP())`,
      [
        row.gym_id,
        String(row.id),
        JSON.stringify(row),
        JSON.stringify({ reason: 'cancelled_without_end_date', ticket: 1694, migration: 297 }),
      ],
    );
  }

  const [del] = await knex.raw(
    `DELETE um FROM user_memberships um WHERE um.id IN (${idList}) AND ${MATCH}`,
    ids,
  );
  if (del.affectedRows !== rows.length) {
    throw new Error(
      `migration 297: counted ${rows.length} cancelled assignment(s) without an end date but deleted ${del.affectedRows}`,
    );
  }
  return { counted: rows.length, deleted: del.affectedRows, detached: detach.affectedRows };
}

exports.deleteCancelledWithoutEndDate = deleteCancelledWithoutEndDate;

exports.up = async (knex) => {
  const { counted, deleted, detached } = await deleteCancelledWithoutEndDate(knex);
  console.log(
    `migration 297: ${counted} cancelled assignment(s) without an end date counted, ${deleted} deleted, `
    + `${detached} payment request(s) kept and detached`,
  );
};

exports.down = async () => {
  // Nothing to restore: the deleted rows are recorded in audit_logs.
};
