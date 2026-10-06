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
 * rather than as a value nothing can write for a second time. The price of that
 * choice is that stage 2 pays this rebuild again (below); CLAUDE.md's
 * `chk_member_notifications_type` rule would have permitted widening once for
 * both, since a CHECK may be a superset of the code's vocabulary, and the call
 * here is deliberately the other way.
 *
 * `draft` is deliberately outside the live-plan statuses (#1108 Q2): a Draft is
 * not the Member's Membership Plan, so `LIVE_ASSIGNMENT_STATUSES` is untouched,
 * a Member may hold one Active plan and one Draft replacement at once, and
 * #956's one-plan check moves from assignment time to the `draft -> active`
 * commit. The UNIQUE index needs no change for that, because migration 213's
 * generated column is `IF(status = 'active', member_id, NULL)` — a Draft row's
 * `active_member_key` is NULL and NULLs do not collide. Note what that *keeps*:
 * the `draft -> active` UPDATE populates the generated column, so the index
 * still backstops the commit with `ER_DUP_ENTRY` if two activations race, and
 * moving the application-level check does not give up the database guarantee.
 *
 * `user_memberships.status` keeps its column DEFAULT of `'active'` (migration
 * 001): all three insert paths name the column explicitly, and changing the
 * default would move what every fixture and seed creates. It is a trap worth
 * naming, though — a *fourth* insert path that omitted the column would create
 * an Active plan with no error — so `api/src/test/draft-assignment-status.unit.test.ts`
 * asserts that every `INSERT INTO user_memberships` names `status` and passes
 * the creation constant rather than a literal.
 *
 * ## The two hazards, which are not the same hazard
 *
 * **Row validation is asymmetric.** MySQL validates every row when a CHECK is
 * added, so *widening* cannot fail on existing rows and `up` has nothing to
 * assert first. *Narrowing* can, so `down` counts the rows that would fail
 * before touching the constraint — 198's device, for 198's reason.
 *
 * **The DROP -> ADD window is symmetric.** DDL is not transactional, so either
 * direction can leave the table with no status CHECK at all if the
 * `ADD CONSTRAINT` fails after the `DROP CHECK` has committed — on a full-table
 * `ALGORITHM=COPY` rebuild that can be tmpdir space, a `lock_wait_timeout` on a
 * busy table or a restart, with no row anywhere at fault. Both directions are
 * therefore **self-healing on re-run**: a `clause == null` read means the window
 * was hit, and each direction simply re-adds its own CHECK. `up`'s is entirely
 * benign, because every existing row (`draft` included) satisfies the wide one.
 *
 * `down` has one window no lock can close: a Draft created by the API *between*
 * its guard's SELECT and its `ADD CONSTRAINT` makes the narrowing fail after the
 * DROP has committed. So **roll the application half back first** — nothing may
 * be writing `draft` while this runs. Re-running `down` repairs that state once
 * the rows are resolved. This matters more here than it did in 198: there,
 * nothing created the retired values and the guard's throw was pathological;
 * here every assignment path creates a Draft, so on a live deployment the throw
 * is the ordinary outcome of rolling back out of order.
 *
 * Both guards compare the CHECK's literal set **exactly** rather than testing it
 * for a substring (migration 185's device, for 185's reason): on a database
 * where 198's own `down` was ever run, 148's six-value CHECK is in place, and a
 * substring test would let `up` return early leaving `awaiting_payment` legal.
 * `down`'s row guard is likewise the *complement of what it writes* rather than
 * a list of its own, so any other stored value — `awaiting_payment` included —
 * is reported instead of failing the `ADD CONSTRAINT`.
 *
 * The constraint keeps its historical name (`user_memberships_status_check`),
 * for the reason 198 gives: renaming it would be a second rebuild for no
 * behaviour, and 148's `down` drops it by this name.
 *
 * Cost: `ADD CONSTRAINT … CHECK` is `ALGORITHM=COPY` (MySQL refuses INPLACE for
 * it), so this rebuilds `user_memberships` once, blocking writes and permitting
 * reads for the duration — the cost CLAUDE.md cites for declining *new* CHECKs
 * on this table (migrations 174, 189, 192, 194). It is paid here for 198's
 * reason: this is the existing CHECK being corrected, not a new one, and leaving
 * it narrow would refuse every INSERT the three assignment paths now make.
 * `ALGORITHM` is not pinned, so a future server able to do better will.
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

  // Every value the narrow CHECK would refuse, not just `draft`: on a database
  // where 198's `down` was ever run, `awaiting_payment` is insertable too, and
  // any such row would fail the ADD CONSTRAINT after the DROP has committed.
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
      `227_draft_membership_status: ${total} user_memberships row(s) hold a status the narrow ` +
      `CHECK would refuse: ${list}${total > sample.length ? ', …' : ''}. Narrowing would fail on ` +
      'them after the DROP CHECK had already committed, leaving the table with no status CHECK ' +
      'at all. Roll the application half back first — nothing may be writing `draft` while this ' +
      'runs, or a row created between this check and the ADD CONSTRAINT reproduces that state. ' +
      'What each row should become (active, or cancelled) is a decision about a member\'s ' +
      'contract, not something a migration may guess: resolve them by hand and re-run, which ' +
      'also repairs a table left with no CHECK. Nothing has been touched.',
    );
  }

  await setStatusCheck(knex, NARROW);
};
