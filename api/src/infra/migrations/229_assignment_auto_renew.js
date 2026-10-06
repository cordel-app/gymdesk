/**
 * #1130 stage 1 — snapshot `auto_renew` onto the Assigned Membership Plan.
 *
 * The ticket settles that a Plan's **Billing & Duration** is a *cycle* rather
 * than a one-shot stretch: Free -> Pre-paid -> Paid -> Bonus starts again when
 * it ends, and `billing_policies.auto_renew` is what says whether it does.
 * That column has existed since migration 032, is shown on the Plan card, and
 * until this ticket was read by **nothing** — so switching the engine on to
 * read the live Plan would have changed what the nightly run charges for every
 * member already enrolled, because it is `NOT NULL DEFAULT true` and therefore
 * on for essentially every Plan in the database. A member who enrolled twenty
 * months ago on a `12 pre-paid + 3 bonus` Plan — billed the regular fee every
 * month today — would have woken up inside a second pre-paid stretch, billed
 * nothing, with no staff action and no explanation.
 *
 * The thread's answer **A** (`new-only`) is this column:
 *
 *   > Auto Renew must be snapshotted onto the assigned membership at the moment
 *   > the membership is assigned, because the assignment is its own commercial
 *   > contract. Existing active assignments must NOT have their billing
 *   > behavior changed by this deployment. Backfill existing user_memberships so
 *   > that they are treated as Auto Renew = OFF / non-repeating.
 *
 * which is also what #635 §13/§17 says about every other commercial term: once
 * assigned, the assignment owns the configuration it was agreed with, and a
 * later edit to the Plan cannot reach it.
 *
 * ## The backfill is the column default
 *
 * `NOT NULL DEFAULT 0` is the whole of it: MySQL writes 0 into every existing
 * row as the column is added, so there is no second statement to resume, no
 * partially backfilled state, and the rows that exist when this runs are
 * non-repeating by construction. `0` is also the value a *future* insert path
 * that forgets the column would get, which is the safe direction — today's
 * behaviour, not a renewal nobody configured.
 *
 * The writer is `snapshotAssignedPlan()`, which every path that inserts a
 * `user_memberships` row already has to call in the same transaction
 * (CLAUDE.md), and which reads the Plan's `billing_policies` row anyway for the
 * cadence. It deliberately does **not** write this column from
 * `materialiseAssignedPlanSnapshot()`: that helper exists to write down what an
 * uncaptured assignment resolves *today*, and what this one resolves today is
 * the stored 0 — capturing the live Plan's value there would switch a legacy
 * assignment to repeating the first time staff edited an unrelated benefit
 * section, which is exactly the retroactive change answer **A** forbids.
 *
 * For the same reason it is **not** part of `has_billing_snapshot` /
 * `snapshot_captured`: those answer "did this assignment capture anything from
 * its Plan?" and key the all-or-nothing duration fallback off it. A NOT NULL
 * column with a default has an answer for every row, so folding it in would
 * report every assignment in the table as captured and freeze that fallback —
 * #772's reasoning for `personal_fee_benefit_action`, unchanged.
 *
 * ## No CHECK, no index
 *
 * `ADD CONSTRAINT` rebuilds `user_memberships` under `ALGORITHM=COPY`;
 * migrations 174, 189, 192, 194 and 215 all declined one on this table for that
 * reason and this follows them. A `TINYINT(1)` written only ever as `? 1 : 0`
 * needs none, and `toPlanDurationRepeats()` is the one place a stored value
 * becomes the boolean the engine reads. The column is not a predicate anywhere
 * — every reader reaches it through a row it already selected on `gym_id` plus
 * the primary key or `member_id` — so an index would pay for nothing.
 *
 * Adding a column with a default is INSTANT on MySQL 8.0.12+ when it goes last,
 * which knex's `alterTable` does, so this is not the table rebuild migration
 * 227 had to pay for the status CHECK.
 *
 * ## `down` is reversible, not round-trippable
 *
 * Dropping the column always succeeds — nothing generated or indexed on this
 * table references it (migration 213's `active_member_key` reads `status` and
 * `member_id` alone) — but the forward direction cannot be replayed without
 * loss. `up` re-defaults **every** row to 0, including the assignments created
 * since this migration whose flag was legitimately frozen at 1: an `up` ->
 * `down` -> `up` round trip would silently turn those renewing contracts into
 * non-renewing ones, which is the same invisible billing change the ticket
 * exists to prevent. Nothing a migration can do about it (the value it would
 * need to restore is the Plan's flag *as it stood then*), so it is stated here
 * rather than left to be inferred — migration 213's device for an
 * irreversibility.
 */

const TABLE = 'user_memberships';
const COLUMN = 'auto_renew';

exports.up = async (knex) => {
  if (await knex.schema.hasColumn(TABLE, COLUMN)) return;
  await knex.schema.alterTable(TABLE, (t) => {
    // Every row that exists when this runs becomes 0 — the backfill, and the
    // reason there is no separate UPDATE to make idempotent.
    t.boolean(COLUMN).notNullable().defaultTo(false);
  });
};

exports.down = async (knex) => {
  // Roll the application half back first, as migration 227's `down` says for
  // its own reason: `snapshotAssignedPlan()` writes this column by name and
  // `loadAssignedPlanSnapshot()` selects it, so dropping it under a deployed
  // API answers ER_BAD_FIELD_ERROR — a bare 500 (#966) on the Assigned Plan
  // card and on every path that creates an assignment.
  if (!(await knex.schema.hasColumn(TABLE, COLUMN))) return;
  await knex.schema.alterTable(TABLE, (t) => t.dropColumn(COLUMN));
};
