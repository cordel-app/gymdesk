/**
 * #785 — the nightly billing run's **dunning state**: two nullable-ish columns
 * on `user_memberships` that let the run tell a first rejection from a second
 * one for the same due cycle, so it can pause the assignment instead of
 * re-charging a declined card every night for ever.
 *
 * ## Why a column pair and not `payment_requests.attempt`
 *
 * The ticket offers both. `attempt` (#640) counts attempts **within one Billing
 * Event**, which is what the *manual* Retry needs: it fires against an existing
 * `failed_billing` event and appends transactions to it, so `MAX(attempt)` for
 * that `billing_event_id` is the attempt number.
 *
 * The nightly run does not work that way. A rejected charge writes a **new**
 * `failed_billing` event every night (`billing.ts` — the ledger is append-only
 * and a run never reuses yesterday's row), each with its own single
 * transaction at `attempt = NULL/1`. So `MAX(attempt)` per event is 1 on night
 * one and 1 again on night two: it cannot see the repetition at all. Counting
 * instead the `failed_billing` *events* since the last settled cycle would
 * work, but it would have to exclude the two non-rejections the run also
 * records as `failed_billing` — `provider_error` and `no_payment_method` — by
 * matching on the `notes` string, which is a display field. A counter the run
 * owns and clears is both cheaper (it is already selecting the row) and honest
 * about what it counts: consecutive **provider rejections** of the cycle
 * `next_billing_date` currently names.
 *
 * `last_failed_at` carries two things. It makes the counter readable after the
 * fact ("one rejection behind this assignment, from last night" vs "…from
 * March"), which is the shape #779's staff queue reads — and it is the run
 * **day** marker the escalation rule needs: `billing.ts` selects
 * `DATE(last_failed_at) = UTC_DATE()` as `rejected_today` and
 * `registerRejection()` refuses to advance the count on a same-day repeat, so
 * #781's 10:00 UTC attempt cannot pause a member the crashed 06:00 run had
 * already charged. Hence DATETIME rather than TIMESTAMP (no session-timezone
 * conversion on the way in or out) and hence the comparison in SQL, never in JS.
 *
 * ## No index
 *
 * Every reader reaches these columns through a row it already selected on
 * `status` + `next_billing_date` (the run) or on the primary key (the staff
 * actions), so neither column is a predicate anywhere and an index would pay
 * for nothing. #779's "assignments with rejections behind them" queue is where
 * one — or a covering predicate — would be decided, on the query it actually
 * writes.
 *
 * ## No CHECK on this table, and no status
 *
 * `ADD CONSTRAINT` rebuilds `user_memberships` under `ALGORITHM=COPY` —
 * migrations 174, 189 and 192 all declined to add one for that reason, and this
 * follows them. The 0..2 range is enforced by `domain/billingDunning.ts`, which
 * clamps whatever it reads, so a row that somehow carried 99 still pauses
 * rather than doing something undefined. The ticket is also explicit that this
 * must not become a status ("do not add a status"): `paused` already exists and
 * already removes the assignment from the run's `WHERE status = 'active'`.
 *
 * ## Not part of the Assigned Plan snapshot
 *
 * Same reasoning as migration 192's personal fee benefit: `has_billing_snapshot`
 * (`FEE_ASSIGNMENT_COLUMNS`) must not grow these columns. They describe how
 * collection is going, not what was captured from the catalogue at assignment
 * time, and `failed_attempts` is NOT NULL with a default — folding it in would
 * answer "captured" for every row in the table and freeze the duration fallback
 * for assignments that captured nothing. Nothing here changes what a cycle
 * costs, so no pricing path reads them.
 *
 * Both adds go through knex's `alterTable` with no `ALGORITHM=` clause and no
 * `.after()`, exactly as 174/189/192 did: appending a nullable column and one
 * with a literal default are `INSTANT`-eligible, and naming the algorithm would
 * turn a table that legitimately needs a rebuild into a hard failure.
 *
 * `down()` is lossy in the harmless direction — it forgets that a card was
 * declined last night, so the next run treats that cycle's next rejection as
 * the first and charges once more before pausing. Nothing is un-billed and no
 * agreement is lost, which is why this one needs no go-to-production note.
 */

const ATTEMPTS_COLUMN = 'failed_attempts';
const LAST_FAILED_COLUMN = 'last_failed_at';

exports.up = async (knex) => {
  // Separate `hasColumn` guards: two non-transactional DDL statements, so a
  // crash between them must leave a re-run able to finish the second
  // (migrations 173/174/189/192 for precedent).
  if (!(await knex.schema.hasColumn('user_memberships', ATTEMPTS_COLUMN))) {
    await knex.schema.alterTable('user_memberships', (t) => {
      // `unsigned`, like every other counter on this table (`free_months`,
      // `paid_months`, `bonus_months`, `pay_beforehand_months`): the count has
      // no meaningful negative value, and the domain clamps to 0..2 anyway.
      t.integer(ATTEMPTS_COLUMN).unsigned().notNullable().defaultTo(0);
    });
  }
  if (!(await knex.schema.hasColumn('user_memberships', LAST_FAILED_COLUMN))) {
    await knex.schema.alterTable('user_memberships', (t) => {
      t.datetime(LAST_FAILED_COLUMN).nullable();
    });
  }
};

exports.down = async (knex) => {
  for (const column of [LAST_FAILED_COLUMN, ATTEMPTS_COLUMN]) {
    if (await knex.schema.hasColumn('user_memberships', column)) {
      await knex.schema.alterTable('user_memberships', (t) => t.dropColumn(column));
    }
  }
};
