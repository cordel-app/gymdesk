/**
 * #1108 stage 1: re-introduce the Assigned Plan's one pre-activation status,
 * `draft`, and widen `user_memberships_status_check` to the five values the
 * status model now has.
 *
 * This is the schema widening migration 198 (#786) said would be needed if a
 * payment gate before activation was ever wanted:
 *
 *   > A payment gate before activation, if one is ever wanted, is a schema
 *   > widening and a ticket of its own.
 *
 * It is **not** a revert of 198. Migration 148 (#511 stage 1) had added *two*
 * pre-activation statuses, `draft` and `awaiting_payment`, and neither was ever
 * written or read. Only `draft` comes back here, with the insert paths and the
 * transition table that make it reachable in the same PR, so after this
 * migration every new assignment is created in it. `awaiting_payment` stays
 * retired: #1108's second pre-activation state is *Pending Payment*, which is
 * stage 2's — it arrives with the Save & Pay transaction that produces it,
 * rather than as a value nothing can write for a second time.
 *
 * `draft` is deliberately outside the live-plan statuses (#1108 Q2): a Draft is
 * not the Member's Membership Plan, so `LIVE_ASSIGNMENT_STATUSES` is untouched,
 * a Member may hold one Active plan and one Draft replacement at once, and
 * #956's one-plan check moves from assignment time to the `draft -> active`
 * commit. The UNIQUE index needs no change for that, because migration 213's
 * generated column is `IF(status = 'active', member_id, NULL)` — a Draft row's
 * `active_member_key` is NULL and collides with nothing.
 *
 * **Widening never fails on existing rows**, so unlike 198's narrowing there is
 * nothing to assert first: no row can be holding `draft` today (198 refuses to
 * run while one does, and nothing has written it since). `down` narrows back to
 * the four values and therefore *does* have to count them, exactly as 198 does
 * and for 198's reason — DDL is not transactional, so a `DROP CHECK` followed by
 * a failing `ADD CONSTRAINT` would leave the table with no status CHECK at all.
 * What a Draft assignment should become on a rollback (`active`? `cancelled`?)
 * is a decision about a member's contract and not something a migration may
 * guess: resolve the rows by hand and re-run.
 *
 * The constraint keeps its historical name (`user_memberships_status_check`),
 * for the reason 198 gives: renaming it would be a second rebuild for no
 * behaviour, and 148's `down` drops it by this name.
 *
 * Cost: `ADD CONSTRAINT … CHECK` is `ALGORITHM=COPY` (MySQL refuses INPLACE for
 * it), so this rebuilds `user_memberships` once under a metadata lock — the cost
 * CLAUDE.md cites for declining *new* CHECKs on this table (migrations 174, 189,
 * 192, 194). It is paid here for 198's reason: this is the existing CHECK being
 * corrected, not a new one, and leaving it narrow would refuse every INSERT the
 * three assignment paths now make.
 */

/** MySQL: ER_CHECK_CONSTRAINT_NOT_FOUND — the only error a DROP CHECK may swallow. */
const ER_CHECK_CONSTRAINT_NOT_FOUND = 3940;

const STATUS_CHECK = 'user_memberships_status_check';
const NARROW = ['active', 'paused', 'cancelled', 'expired'];
const WIDE = ['draft', ...NARROW];

/**
 * The status CHECK's clause with MySQL's escaping removed, or null when the
 * table has none. MySQL stores each literal with a charset prefix and escaped
 * quotes (`_utf8mb4\'draft\'`), so the backslashes come off before matching.
 */
const statusCheckClause = async (knex) => {
  const rows = await knex.raw(
    `SELECT cc.CHECK_CLAUSE
       FROM information_schema.CHECK_CONSTRAINTS cc
       JOIN information_schema.TABLE_CONSTRAINTS tc
         ON tc.CONSTRAINT_SCHEMA = cc.CONSTRAINT_SCHEMA
        AND tc.CONSTRAINT_NAME = cc.CONSTRAINT_NAME
      WHERE tc.TABLE_SCHEMA = DATABASE()
        AND tc.TABLE_NAME = 'user_memberships'
        AND cc.CONSTRAINT_NAME = ?`,
    [STATUS_CHECK],
  );
  const clause = rows[0][0]?.CHECK_CLAUSE;
  return clause == null ? null : clause.replace(/\\/g, '');
};

const setStatusCheck = async (knex, values) => {
  await knex.raw(`ALTER TABLE user_memberships DROP CHECK ${STATUS_CHECK}`).catch((err) => {
    if (err.errno !== ER_CHECK_CONSTRAINT_NOT_FOUND) throw err;
  });
  await knex.raw(
    `ALTER TABLE user_memberships ADD CONSTRAINT ${STATUS_CHECK} ` +
    `CHECK (status IN (${values.map((v) => `'${v}'`).join(',')}))`,
  );
};

exports.up = async (knex) => {
  const clause = await statusCheckClause(knex);
  if (clause != null && clause.includes("'draft'")) return;
  await setStatusCheck(knex, WIDE);
};

exports.down = async (knex) => {
  const clause = await statusCheckClause(knex);
  if (clause != null && !clause.includes("'draft'")) return;

  const rows = await knex.raw(
    "SELECT id, gym_id FROM user_memberships WHERE status = 'draft' ORDER BY id LIMIT 20",
  );
  const stuck = rows[0];
  if (stuck.length > 0) {
    const list = stuck.map((r) => `#${r.id} (gym ${r.gym_id})`).join(', ');
    throw new Error(
      `227_draft_membership_status: user_memberships still holds Draft assignments: ${list}` +
      `${stuck.length === 20 ? ', …' : ''}. Narrowing the status CHECK would fail on them ` +
      'after the DROP CHECK had already run, leaving the table with no status CHECK at all. ' +
      'What each Draft should become (active, or cancelled) is a decision about a member\'s ' +
      'contract, not something a migration may guess: resolve the rows by hand and re-run. ' +
      'The status CHECK has not been touched.',
    );
  }

  await setStatusCheck(knex, NARROW);
};
