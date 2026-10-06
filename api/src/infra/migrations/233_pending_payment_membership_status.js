/**
 * #1108 stage 2: add the Assigned Plan's second pre-activation status,
 * `pending_payment`, and widen `user_memberships_status_check` to the six values
 * the status model now has.
 *
 * Migration 227 (stage 1) brought back `draft` alone and said why this rebuild
 * would be paid twice:
 *
 *   > `awaiting_payment` stays retired: #1108's second pre-activation state is
 *   > *Pending Payment*, which is stage 2's — it arrives with the Save & Pay
 *   > transaction that produces it, rather than as a value nothing can write for
 *   > a second time.
 *
 * This is that arrival, and the value is spelled `pending_payment` rather than
 * reviving 148's `awaiting_payment`: it is the status the owner's Q1 answer
 * names (*Pending Payment*), the one the admin renders and the one
 * `api/src/domain/assignmentCommit.ts` declares, and reusing a retired spelling
 * for a state with different rules is how a vocabulary comes to have two names
 * for one thing. `awaiting_payment` therefore stays retired for good, and is
 * still refused by this CHECK.
 *
 * ## What this status is, and what it is not
 *
 * `pending_payment` is **not live**: like `draft` it is outside
 * `LIVE_ASSIGNMENT_STATUSES`, so migration 213's UNIQUE index needs no change
 * (its generated column is `IF(status = 'active', member_id, NULL)`, which is
 * NULL for both), a member may hold one Active plan and one committed-but-unpaid
 * replacement at once, and #956's one-plan check stays on the `-> active` commit
 * where stage 1 put it. It is also not bookable, bills nothing and is invisible
 * to every "does this member hold a plan" reader, for the same reasons a Draft
 * is.
 *
 * What it adds over `draft` is that the configuration is **locked**: Save & Pay
 * has raised a charge for exactly that configuration, so letting it change while
 * the member is on the hosted page would make the amount they are being asked
 * for stop matching the plan it buys. There is deliberately no path back to
 * `draft` — staff close a Pending Payment the way they discard a Draft.
 *
 * ## No backfill, and nothing to migrate
 *
 * Every existing row is `draft`, `active`, `paused`, `cancelled` or `expired`
 * and keeps exactly what it holds: this migration only makes a sixth value
 * *legal*, and the only writer of it is `POST /user-memberships/:id/save-and-pay`.
 * A deployment that never uses Save & Pay never sees the value.
 *
 * ## The two hazards, which are not the same hazard
 *
 * Both are 227's, for 227's reasons, and the mechanics below are deliberately
 * its mechanics rather than a second device:
 *
 * **Row validation is asymmetric.** MySQL validates every row when a CHECK is
 * added, so *widening* cannot fail on existing rows and `up` has nothing to
 * assert first. *Narrowing* can, so `down` counts the rows that would fail
 * before touching the constraint.
 *
 * **The DROP -> ADD window is symmetric.** DDL is not transactional, so either
 * direction can leave the table with no status CHECK at all if the
 * `ADD CONSTRAINT` fails after the `DROP CHECK` has committed. Both directions
 * are therefore self-healing on re-run: a `clause == null` read means the window
 * was hit, and each direction re-adds its own CHECK. `up`'s is benign, because
 * every existing row satisfies the wide one.
 *
 * `down` has one window no lock can close: a Pending Payment created by the API
 * *between* its guard's SELECT and its `ADD CONSTRAINT` makes the narrowing fail
 * after the DROP has committed. So roll the application half back first —
 * nothing may be writing `pending_payment` while this runs. Re-running `down`
 * repairs that state once the rows are resolved. Note what a row in this status
 * means for whoever has to resolve one: a member has been asked to pay and the
 * provider has not answered yet, so neither `active` nor `cancelled` is a safe
 * guess, which is why the guard reports the rows instead of writing one.
 *
 * Both guards compare the CHECK's literal set **exactly** rather than testing it
 * for a substring (migration 185's device, repeated by 227): on a database where
 * 198's or 227's own `down` was run, a different set is in place, and a substring
 * test would let `up` return early leaving that set alone.
 *
 * The constraint keeps its historical name (`user_memberships_status_check`),
 * for 198's reason: renaming it would be a second rebuild for no behaviour.
 *
 * Cost: `ADD CONSTRAINT … CHECK` is `ALGORITHM=COPY` (MySQL refuses INPLACE for
 * it), so this rebuilds `user_memberships` once, blocking writes and permitting
 * reads for the duration — the second payment of the cost 227 named. It is the
 * existing CHECK being corrected rather than a new one, and leaving it narrow
 * would make every Save & Pay fail with a constraint violation.
 */

/** MySQL: ER_CHECK_CONSTRAINT_NOT_FOUND — the only error a DROP CHECK may swallow. */
const ER_CHECK_CONSTRAINT_NOT_FOUND = 3940;

const STATUS_CHECK = 'user_memberships_status_check';
const NARROW = ['draft', 'active', 'paused', 'cancelled', 'expired'];
const WIDE = ['pending_payment', ...NARROW];

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

/** The literal set inside that clause, sorted, or null when the table has none. */
const statusCheckValues = async (knex) => {
  const clause = await statusCheckClause(knex);
  if (clause == null) return null;
  return [...clause.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
};

/** Is the stored set exactly `wanted`? An extra value is as wrong as a missing one. */
const isStatusSet = (current, wanted) => {
  if (current == null) return false;
  const target = [...wanted].sort();
  return current.length === target.length && current.every((v, i) => v === target[i]);
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
  if (isStatusSet(await statusCheckValues(knex), WIDE)) return;
  await setStatusCheck(knex, WIDE);
};

exports.down = async (knex) => {
  if (isStatusSet(await statusCheckValues(knex), NARROW)) return;

  // Every value the narrow CHECK would refuse, not just `pending_payment`: on a
  // database where an older `down` was run, other retired values may be
  // insertable too, and any such row would fail the ADD CONSTRAINT after the
  // DROP has committed.
  const marks = NARROW.map(() => '?').join(',');
  const [counted] = await knex.raw(
    `SELECT COUNT(*) AS n FROM user_memberships WHERE status NOT IN (${marks})`,
    NARROW,
  );
  const total = Number(counted[0]?.n ?? 0);
  if (total > 0) {
    const [sample] = await knex.raw(
      `SELECT id, gym_id, status FROM user_memberships
        WHERE status NOT IN (${marks})
        ORDER BY id LIMIT 20`,
      NARROW,
    );
    const list = sample.map((r) => `#${r.id} (gym ${r.gym_id}, ${r.status})`).join(', ');
    throw new Error(
      `233_pending_payment_membership_status: ${total} user_memberships row(s) hold a status the ` +
      `narrow CHECK would refuse: ${list}${total > sample.length ? ', …' : ''}. Narrowing would ` +
      'fail on them after the DROP CHECK had already committed, leaving the table with no status ' +
      'CHECK at all. Roll the application half back first — nothing may be writing ' +
      '`pending_payment` while this runs, or a row created between this check and the ' +
      'ADD CONSTRAINT reproduces that state. What each row should become is a decision about a ' +
      'member\'s contract and about money the provider may still be settling, not something a ' +
      'migration may guess: resolve them by hand and re-run, which also repairs a table left ' +
      'with no CHECK. Nothing has been touched.',
    );
  }

  await setStatusCheck(knex, NARROW);
};
