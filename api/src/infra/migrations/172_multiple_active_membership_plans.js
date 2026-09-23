/**
 * #634 §6/§14: a Member may hold several active Membership Plans at once —
 * "several plans in parallel, but only one of each type" (issue thread).
 *
 * Migration 007 enforced the opposite rule: the generated column
 * `active_member_key` (= member_id while the row is active, NULL otherwise)
 * under a single-column UNIQUE index, so a second active row for the same
 * Member collided. That is exactly what #634 requires to stop happening —
 * adding a Membership Plan must not close, cancel or replace an existing one
 * (§14), so both rows have to be allowed to be active at the same time.
 *
 * The constraint is narrowed rather than dropped: the same index column gains
 * `membership_plan_id`, so the same Plan can still only be active once per
 * Member while different Plans coexist. Keeping a constraint here matters
 * because it is what makes two concurrent assignment POSTs safe — the API's own
 * "is this Plan already assigned?" check cannot, on its own, sit between a
 * SELECT and an INSERT.
 *
 * `active_member_key` is reused as-is instead of being replaced by a new
 * concatenated key: it already encodes "active, for this Member", it is an
 * INT UNSIGNED (a narrower index than a VARCHAR), and every existing reference
 * to it — docs, the assign-new-plan comments — stays accurate. So this is a
 * two-statement index swap with no column churn.
 *
 * A UNIQUE index ignores a row whose value is NULL in *any* part, which gives
 * two exemptions:
 *   - non-active rows, as before (`active_member_key` is NULL);
 *   - rows with no `membership_plan_id`. That one is new: legacy rows
 *     predating migration 007's backfill carry only the dropped `plan` text
 *     column, and they used to be capped at one active row per Member. Every
 *     insert path today requires `membership_plan_id` (POST /user-memberships,
 *     assign-new-plan, POST /membership-plans/:id/assign), so no new row can
 *     land in that gap; closing it for good means making the column NOT NULL,
 *     which is a separate migration with its own backfill.
 *
 * No data migration is required and none could go wrong: the old index allowed
 * at most one active row per Member, which trivially satisfies at most one
 * active row per (Member, Plan). Every existing assignment is preserved
 * untouched, and neither statement rebuilds the table or takes a long lock.
 *
 * MySQL DDL is non-transactional, so each step is guarded independently — a
 * re-run after a mid-migration failure resumes instead of permanently skipping
 * a step (same convention as migrations 134/140/155/164).
 */

const TABLE = 'user_memberships';
const OLD_INDEX = 'user_memberships_one_active';
const NEW_INDEX = 'user_memberships_one_active_per_plan';

async function indexExists(knex, name) {
  const [rows] = await knex.raw(`SHOW INDEX FROM ${TABLE} WHERE Key_name = ?`, [name]);
  return rows.length > 0;
}

exports.up = async (knex) => {
  if (await indexExists(knex, OLD_INDEX)) {
    await knex.raw(`ALTER TABLE ${TABLE} DROP INDEX ${OLD_INDEX}`);
  }
  if (!(await indexExists(knex, NEW_INDEX))) {
    await knex.raw(
      `ALTER TABLE ${TABLE} ADD UNIQUE KEY ${NEW_INDEX} (active_member_key, membership_plan_id)`,
    );
  }
};

exports.down = async (knex) => {
  // Restoring the one-active-per-Member index fails on any Member this feature
  // gave two active Plans to. Check first and stop with an actionable message
  // rather than letting ADD UNIQUE KEY blow up halfway through, which would
  // leave the table with neither index enforcing.
  const [conflicts] = await knex.raw(
    `SELECT member_id, COUNT(*) AS n FROM ${TABLE}
     WHERE status = 'active' GROUP BY member_id HAVING n > 1`,
  );
  if (conflicts.length > 0) {
    throw new Error(
      `Cannot roll back 172: ${conflicts.length} member(s) hold more than one active membership ` +
      `(member_id: ${conflicts.map((r) => r.member_id).join(', ')}). ` +
      'Expire or cancel the extra assignments first, then re-run the rollback.',
    );
  }

  if (await indexExists(knex, NEW_INDEX)) {
    await knex.raw(`ALTER TABLE ${TABLE} DROP INDEX ${NEW_INDEX}`);
  }
  if (!(await indexExists(knex, OLD_INDEX))) {
    await knex.raw(`ALTER TABLE ${TABLE} ADD UNIQUE KEY ${OLD_INDEX} (active_member_key)`);
  }
};
