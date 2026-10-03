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
 * The index cannot be created while any Member owns two active rows, so the
 * violators have to go one way or the other. The ticket asks that they be
 * identified before anything is cancelled and the owner answered the question
 * on the thread: *"Migrate. Just cancel the older plans. If you cannot determine
 * which ones are the older plans, just choose one random as the active one."*
 * `npm run memberships:multi-active` is the read-only report that identifies
 * them (run it before migrating — it is the only way to see what this will
 * cancel), and the sweep below is that instruction:
 *
 *   - it groups the live rows (`active` and `paused`, which #956 Q2 makes
 *     equivalent for this rule) by **owning** `member_id`;
 *   - the keeper is the one a gym would call current: `active` before `paused`,
 *     then the latest `starts_at`, then the latest row. That ordering is total,
 *     so "choose one at random" never has to happen — two rows that tie on
 *     status and start date are separated by `id`;
 *   - every other live row of that Member becomes `cancelled`, with `closed_at`
 *     stamped and `ends_at` set to the keeper's `starts_at` — the same shape
 *     `supersedeLiveAssignments()` writes for a replacement made through the
 *     API, so a swept row reads on the Assigned Plans screens exactly like a
 *     superseded one;
 *   - and a `status_changed` row is appended to `billing_events` for each, with
 *     `source = 'system'`, because the ledger is where a status flip is
 *     explained and a cancellation nobody can account for is worse than none.
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
 * `down()` is migration 172's `up()`: the narrower index comes back and nothing
 * is un-cancelled, because the sweep is not reversible — the rows it closed are
 * indistinguishable from the ones an admin closed.
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
  // 1. The sweep. One statement per row rather than a single correlated UPDATE:
  //    each cancellation needs the keeper's own `starts_at` as its `ends_at`,
  //    and each needs a ledger row, so the set is read first and then written.
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

  for (const rows of byMember.values()) {
    if (rows.length < 2) continue;
    const [keeper, ...superseded] = rows;
    for (const row of superseded) {
      await knex.raw(
        `UPDATE ${TABLE}
         SET status = 'cancelled', closed_at = UTC_TIMESTAMP(), ends_at = ?
         WHERE id = ?`,
        [keeper.starts_at, row.id],
      );
      await knex.raw(
        `INSERT INTO billing_events
           (gym_id, user_membership_id, member_id, event_type, previous_status, new_status, source)
         VALUES (?, ?, ?, 'status_changed', ?, 'cancelled', 'system')`,
        [row.gym_id, row.id, row.member_id, row.status],
      );
    }
  }

  // 2. The index swap.
  if (await indexExists(knex, PER_PLAN_INDEX)) {
    await knex.raw(`ALTER TABLE ${TABLE} DROP INDEX ${PER_PLAN_INDEX}`);
  }
  if (!(await indexExists(knex, ONE_ACTIVE_INDEX))) {
    await knex.raw(`ALTER TABLE ${TABLE} ADD UNIQUE KEY ${ONE_ACTIVE_INDEX} (active_member_key)`);
  }
};

exports.down = async (knex) => {
  if (await indexExists(knex, ONE_ACTIVE_INDEX)) {
    await knex.raw(`ALTER TABLE ${TABLE} DROP INDEX ${ONE_ACTIVE_INDEX}`);
  }
  if (!(await indexExists(knex, PER_PLAN_INDEX))) {
    await knex.raw(
      `ALTER TABLE ${TABLE} ADD UNIQUE KEY ${PER_PLAN_INDEX} (active_member_key, membership_plan_id)`,
    );
  }
};
