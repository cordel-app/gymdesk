/**
 * #956 — **one member, one active Membership Plan.** This restores migration
 * 007's rule and reverses migration 172's widening of it.
 *
 * Migration 007 enforced one active assignment per Member through the generated
 * column `active_member_key` (= `member_id` while the row is active, NULL
 * otherwise) under a single-column UNIQUE index. Migration 172 (#634 §6/§14)
 * narrowed that index to `(active_member_key, membership_plan_id)` — "several
 * plans in parallel, but only one of each type". #956 reverses that product
 * decision: a Member holds zero or one Membership Plan, and assigning a new one
 * cancels the one they have.
 *
 * So this is migration 172's `down()` plus the data sweep it refuses to do.
 * The column itself is untouched; this is a two-statement index swap with no
 * table rebuild, preceded by one UPDATE.
 *
 * ### The sweep (the ticket's "Existing members with multiple active plans")
 *
 * `active_member_key` is `IF(status = 'active', member_id, NULL)`, so the index
 * forbids two **`active`** rows and those violators have to go one way or the
 * other — it would reject the `ADD UNIQUE KEY` below. #956 Q2 then makes
 * `paused` equivalent to `active` for the rule, so the sweep closes a Member
 * down to one **live** row rather than one active one. That half is a *product
 * decision and not an index prerequisite*: a Member holding two `paused` rows
 * would never have collided, and this cancels one of them anyway because under
 * the new rule they are not allowed to hold both.
 *
 * The ticket asks that the violators be identified before anything is cancelled
 * and the owner answered the question on the thread: *"Migrate. Just cancel the
 * older plans. If you cannot determine which ones are the older plans, just
 * choose one random as the active one."* `npm run memberships:multi-active` is
 * the read-only report that identifies them (run it before migrating — it is
 * the only way to see what this will cancel), and the sweep below is that
 * instruction:
 *
 *   - it groups the live rows (`active` and `paused`) by **owning** `member_id`;
 *   - the keeper is the one a gym would call current: `active` before `paused`,
 *     then the latest `starts_at`, then the latest row. That ordering is total,
 *     so "choose one at random" never has to happen — two rows that tie on
 *     status and start date are separated by `id`;
 *   - every other live row of that Member becomes `cancelled`, with `closed_at`
 *     stamped and `ends_at` set to the keeper's `starts_at` — the shape
 *     `supersedeLiveAssignments()` writes for a replacement made through the
 *     API, so a swept row reads on the Assigned Plans screens exactly like a
 *     superseded one. With one difference the API cannot produce: there the date
 *     is the *incoming* assignment's start, which is always at or after the
 *     superseded row's own, while the keeper here is chosen **status-first** and
 *     can therefore have started *earlier* than a newer `paused` row. So the
 *     date is clamped with `GREATEST(…, starts_at)`: an `ends_at` before its own
 *     `starts_at` is a range no screen can render and `GET /user-memberships`'s
 *     own `start_date` filter (`ends_at >= ?`) would hide the row from the very
 *     period the Member held it — irreversibly, since `down()` cannot restore
 *     the date it overwrote. A same-day zero-length range is the worst case;
 *   - and a `status_changed` row is appended to `billing_events` for each, with
 *     `source = 'system'` and a `notes` marker naming this migration and the
 *     keeper, because the ledger is where a status flip is explained, a
 *     cancellation nobody can account for is worse than none, and the marker is
 *     the only thing that tells a swept row apart from one an admin closed.
 *
 * What the sweep deliberately leaves alone: a Member who is a **covered member**
 * of someone else's family plan *and* owns one of their own. That overlap is
 * real under the new rule, but `active_member_key` is keyed on the owner so the
 * index does not forbid it, and cancelling a family plan because one of the
 * people it covers has their own would take the plan away from everyone else on
 * it — a decision for the gym, not for a migration. The API enforces the rule
 * for every *new* assignment (`findLiveAssignmentsForMembers()` reads
 * `user_membership_members`, #956 Q4) and the report lists the leftovers.
 *
 * `down()` is migration 172's `up()`: the wider index comes back and nothing is
 * un-cancelled, because the sweep is not reversible — the `ends_at` it
 * overwrote is gone, and a rollback that guessed a status back would be
 * inventing one. It says so out loud rather than rolling back silently, and the
 * `notes` marker is what makes the affected rows findable by hand afterwards.
 * Its own DDL ordering is safe in that direction: `(active_member_key,
 * membership_plan_id)` can never collide on data that already satisfied
 * `(active_member_key)`.
 *
 * MySQL DDL is non-transactional, so each step is guarded independently — a
 * re-run after a mid-migration failure resumes instead of permanently skipping
 * a step (same convention as migrations 134/140/155/164/172).
 */

const TABLE = 'user_memberships';
const PER_PLAN_INDEX = 'user_memberships_one_active_per_plan';
const ONE_ACTIVE_INDEX = 'user_memberships_one_active';

async function indexExists(knex, name) {
  const [rows] = await knex.raw(`SHOW INDEX FROM ${TABLE} WHERE Key_name = ?`, [name]);
  return rows.length > 0;
}

exports.up = async (knex) => {
  // 0. The ledger row the sweep writes needs a gym: `user_memberships.gym_id` is
  //    nullable (it predates the `subscriptions` rename) while
  //    `billing_events.gym_id` is NOT NULL, so a live assignment carrying none
  //    would abort the sweep on a bare ER_BAD_NULL_ERROR naming no row. Say
  //    which rows and what to do about them instead. (The whole batch runs in
  //    one knex transaction and every ALTER is below, so nothing has committed
  //    at this point — the failure is clean, just opaque without this.)
  const [orphans] = await knex.raw(
    `SELECT id FROM ${TABLE} WHERE status IN ('active', 'paused') AND gym_id IS NULL`,
  );
  if (orphans.length > 0) {
    throw new Error(
      `Cannot run 213: ${orphans.length} live assignment(s) carry no gym_id `
      + `(id: ${orphans.map((r) => r.id).join(', ')}). The billing_events row the sweep `
      + 'writes requires one — set gym_id on those rows, or close them, then re-run.',
    );
  }

  // 1. The sweep. One statement per row rather than a single correlated UPDATE:
  //    each cancellation needs the keeper's own `starts_at` as its `ends_at`,
  //    and each needs a ledger row, so the set is read first and then written.
  //
  //    `status` carries no index, so this is a full scan that materialises every
  //    live row in Node. The violator set can only have grown for the lifetime
  //    of #634 and the pre-flight report says how big it is, so a one-off scan
  //    is the right trade here — but if that report comes back with thousands of
  //    rows, run the sweep in slices ahead of the migration rather than letting
  //    one transaction hold every lock until the first ALTER commits.
  const [live] = await knex.raw(
    `SELECT id, gym_id, member_id, status,
            DATE_FORMAT(starts_at, '%Y-%m-%d') AS starts_at
     FROM ${TABLE}
     WHERE status IN ('active', 'paused')
     ORDER BY member_id ASC,
              (status = 'active') DESC,
              starts_at DESC,
              id DESC`,
  );

  const byMember = new Map();
  for (const row of live) {
    const list = byMember.get(row.member_id) ?? [];
    list.push(row);
    byMember.set(row.member_id, list);
  }

  let sweptRows = 0;
  let sweptMembers = 0;
  for (const rows of byMember.values()) {
    if (rows.length < 2) continue;
    const [keeper, ...superseded] = rows;
    sweptMembers += 1;
    for (const row of superseded) {
      await knex.raw(
        `UPDATE ${TABLE}
         SET status = 'cancelled',
             closed_at = UTC_TIMESTAMP(),
             -- The keeper's start date, but never before this row's own: the
             -- keeper is picked status-first, so it can have started earlier
             -- than a newer paused row (see the header).
             ends_at = GREATEST(CAST(? AS DATE), starts_at)
         WHERE id = ?`,
        [keeper.starts_at, row.id],
      );
      await knex.raw(
        `INSERT INTO billing_events
           (gym_id, user_membership_id, member_id, event_type,
            previous_status, new_status, source, notes)
         VALUES (?, ?, ?, 'status_changed', ?, 'cancelled', 'system', ?)`,
        [
          row.gym_id, row.id, row.member_id, row.status,
          `Migration 213 (#956): superseded by assignment #${keeper.id}`,
        ],
      );
      sweptRows += 1;
    }
  }
  if (sweptRows > 0) {
    // The only record of what this did, besides the ledger rows themselves.
    console.warn(
      `Migration 213 (#956): cancelled ${sweptRows} live assignment(s) across `
      + `${sweptMembers} member(s). See billing_events.notes for which, and which row kept.`,
    );
  }

  // 2. The index swap — ADD before DROP. MySQL DDL is non-transactional, so the
  //    first ALTER implicitly commits the sweep: if the ADD went second and hit
  //    ER_DUP_ENTRY, the table would be left with *neither* index and nothing at
  //    all enforcing one active plan per Member. In this order a failure leaves
  //    the old constraint standing. The two coexist happily on the same
  //    generated column for the one statement in between.
  //
  //    ALGORITHM=INPLACE, LOCK=NONE is asserted rather than hoped for: this is a
  //    secondary index on a VIRTUAL generated column, so the server can add it
  //    in place with concurrent DML, and a server that could only do it by
  //    rebuilding `user_memberships` under a lock should say so loudly instead.
  if (!(await indexExists(knex, ONE_ACTIVE_INDEX))) {
    await knex.raw(
      `ALTER TABLE ${TABLE} ADD UNIQUE KEY ${ONE_ACTIVE_INDEX} (active_member_key),
       ALGORITHM=INPLACE, LOCK=NONE`,
    );
  }
  if (await indexExists(knex, PER_PLAN_INDEX)) {
    await knex.raw(`ALTER TABLE ${TABLE} DROP INDEX ${PER_PLAN_INDEX}`);
  }
};

exports.down = async (knex) => {
  // The DDL rolls back; the sweep does not, and an operator rolling back should
  // hear that rather than discover it. ADD before DROP here too, for `up()`'s
  // reason — though this direction cannot collide, since data satisfying
  // `(active_member_key)` satisfies `(active_member_key, membership_plan_id)`.
  const [swept] = await knex.raw(
    `SELECT COUNT(*) AS n FROM billing_events
     WHERE event_type = 'status_changed' AND notes LIKE 'Migration 213 (#956):%'`,
  );
  if (Number(swept[0]?.n ?? 0) > 0) {
    console.warn(
      `Rolling back 213 restores the index only: the ${swept[0].n} assignment(s) its sweep `
      + 'cancelled stay cancelled, with the ends_at it wrote (the original is gone) and their '
      + "ledger rows. Find them with: SELECT * FROM billing_events WHERE notes LIKE 'Migration 213 (#956):%'",
    );
  }

  if (!(await indexExists(knex, PER_PLAN_INDEX))) {
    await knex.raw(
      `ALTER TABLE ${TABLE} ADD UNIQUE KEY ${PER_PLAN_INDEX} (active_member_key, membership_plan_id),
       ALGORITHM=INPLACE, LOCK=NONE`,
    );
  }
  if (await indexExists(knex, ONE_ACTIVE_INDEX)) {
    await knex.raw(`ALTER TABLE ${TABLE} DROP INDEX ${ONE_ACTIVE_INDEX}`);
  }
};
