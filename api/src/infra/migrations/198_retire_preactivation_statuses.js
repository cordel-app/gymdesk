/**
 * #786: retire the Assigned Plan's two pre-activation statuses, `draft` and
 * `awaiting_payment`, and narrow `user_memberships_status_check` back to the
 * four values migration 148 widened it from.
 *
 * Migration 148 (#511 stage 1) added both for a "prepare → submit → pay →
 * activate" lifecycle that was never wired: every insert path writes `'active'`
 * (`POST /user-memberships`, `POST /user-memberships/:id/assign-new-plan`,
 * `POST /membership-plans/:id/assign`), and no payment path — the webhook's
 * `completed` branch, a manual payment, the nightly run — ever moved a row from
 * `awaiting_payment` to `active`. The owner chose to retire them rather than wire
 * them (#786 Q1 = Option 2): an assignment is `active` from creation and its
 * first payment is collected afterwards. The API's status lists, the transition
 * table and `POST /user-memberships/:id/submit` go in the same PR, so after this
 * migration nothing can write either value and the CHECK says so.
 *
 * **Existing rows are asserted, never converted.** MySQL validates every row
 * when a CHECK is added, so a `draft`/`awaiting_payment` row would make the
 * `ADD CONSTRAINT` fail anyway — but only *after* the `DROP CHECK` had run, and
 * DDL is not transactional, which would leave the table with no status CHECK at
 * all. So `up` counts those rows first and refuses, naming them, before touching
 * the constraint. Nothing creates such a row, so on a real database the count is
 * zero; if it is not, what the row should become (`active`? `cancelled`?) is a
 * decision about a member's contract, not something a migration may guess.
 * Resolve the rows by hand and re-run.
 *
 * The constraint keeps its historical name (`user_memberships_status_check`, not
 * `chk_user_memberships_status`): renaming it would be a second rebuild for no
 * behaviour, and migration 148's `down` drops it by this name.
 *
 * Cost: `ADD CONSTRAINT … CHECK` is `ALGORITHM=COPY` (MySQL refuses INPLACE for
 * it), so this rebuilds `user_memberships` once under a metadata lock — the cost
 * CLAUDE.md cites for declining new CHECKs on this table (migrations 174, 189,
 * 192, 194). It is paid here because this is not a *new* CHECK but the existing
 * one being corrected, and leaving it wide would keep advertising two statuses
 * the code no longer knows. Both directions are guarded on the clause already in
 * place, so a re-run after success copies nothing.
 *
 * `down` restores migration 148's six-value CHECK. Widening never fails on
 * existing rows, and the rolled-back build's `STATUSES` accepts the values again.
 */

/** MySQL: ER_CHECK_CONSTRAINT_NOT_FOUND — the only error a DROP CHECK may swallow. */
const ER_CHECK_CONSTRAINT_NOT_FOUND = 3940;

const STATUS_CHECK = 'user_memberships_status_check';
const RETIRED = ['draft', 'awaiting_payment'];
const NARROW = ['active', 'paused', 'cancelled', 'expired'];
const WIDE = ['draft', 'awaiting_payment', ...NARROW];

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
  const alreadyNarrow = clause != null && RETIRED.every((v) => !clause.includes(`'${v}'`));
  if (alreadyNarrow) return;

  const rows = await knex.raw(
    `SELECT id, gym_id, status FROM user_memberships
      WHERE status IN (${RETIRED.map(() => '?').join(',')})
      ORDER BY id LIMIT 20`,
    RETIRED,
  );
  const stuck = rows[0];
  if (stuck.length > 0) {
    const list = stuck.map((r) => `#${r.id} (gym ${r.gym_id}, ${r.status})`).join(', ');
    throw new Error(
      `198_retire_preactivation_statuses: user_memberships still holds rows in a retired status ` +
      `('draft'/'awaiting_payment'): ${list}${stuck.length === 20 ? ', …' : ''}. ` +
      'No code path creates these (#786), so they were written by hand; decide what each ' +
      'assignment should be (active or cancelled) and update it explicitly, then re-run the ' +
      'migration. The status CHECK has not been touched.',
    );
  }

  await setStatusCheck(knex, NARROW);
};

exports.down = async (knex) => {
  const clause = await statusCheckClause(knex);
  const alreadyWide = clause != null && RETIRED.every((v) => clause.includes(`'${v}'`));
  if (alreadyWide) return;
  await setStatusCheck(knex, WIDE);
};
