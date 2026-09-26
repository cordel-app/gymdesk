/**
 * #772 — the **Personal Membership Fee Benefit** on an Assigned Membership Plan.
 *
 * Every existing way of changing what the Membership Fee costs is bounded in
 * time: a Promotion's Membership Fee Benefit lives inside that Promotion's own
 * Free/Paid/Bonus timeline and ends with it (#635 stage 12), and the Plan's
 * Free / Pre-paid / Bonus durations are counted from `starts_at` and run out.
 * The ticket asks for one that does not:
 *
 *   > This benefit is not tied to the Promotion and must not expire when a
 *   > Promotion ends. The benefit remains active for the entire lifetime of the
 *   > Assigned Membership Plan, unless the Assigned Membership Plan is
 *   > explicitly edited to change or remove it.
 *
 * So it belongs to the assignment, not to any Promotion and not to the Plan:
 * two columns on `user_memberships`, read on every cycle by
 * `resolveMembershipFee()` and applied on top of whatever that resolves.
 *
 * ## Why an (action, value) pair rather than a single percentage column
 *
 * The ticket's options are exactly `No benefit` and `% discount`, so a single
 * nullable `personal_discount_percent` would express today's requirement. The
 * pair is stored instead because it is the vocabulary every other benefit in
 * this schema already uses (`PromotionBenefitAction`:
 * `no_benefit | waive | percentage_discount | fixed_discount | fixed_price`,
 * migrations 092/102/144), and `applyPeriodBenefit()` is the one place that
 * turns such a pair into an amount. Sharing it means the personal benefit is
 * priced by the same arithmetic as every other one rather than by a second
 * copy of `amount - amount * pct / 100`. The *router* is what restricts the
 * action to the ticket's two values — widening that set is a product decision,
 * not a schema change.
 *
 * ## Not part of the Assigned Plan snapshot
 *
 * `has_billing_snapshot` (the expression `FEE_ASSIGNMENT_COLUMNS` and
 * `loadAssignedPlanSnapshot()` compute) deliberately does **not** grow these
 * two columns, and `materialiseAssignedPlanSnapshot()` is deliberately **not**
 * called when they are written. The snapshot is what was captured *from the
 * catalogue* at assignment time, and its fallback is all-or-nothing: whether an
 * assignment reads its own durations or its Plan's live ones must not change
 * because a member was given a personal discount. These columns have no
 * catalogue counterpart to fall back to — they are NOT NULL with a default, so
 * every row already has an answer — and including them would flip every
 * assignment to "captured" the moment this migration ran, freezing the
 * catalogue fallback for assignments that never captured anything.
 *
 * ## No CHECK on this table
 *
 * `ADD CONSTRAINT` rebuilds the table under `ALGORITHM=COPY`, and
 * `user_memberships` is the busiest table in the schema — migrations 174 and
 * 189 both declined to add one to it for that reason, and this follows them.
 * The 0..100 bound and the "a percentage discount has a value" pairing are
 * enforced by `PUT /user-memberships/:id/fee-benefit` and by
 * `toPersonalFeeBenefit()` (`api/src/domain/personalFeeBenefit.ts`), which
 * clamps whatever it reads — so a row that somehow carried 150% would still
 * price at zero rather than negative.
 *
 * The column types are the ones every other benefit action/value pair in this
 * schema already uses — `VARCHAR(30)` and `DECIMAL(10,2)` (migrations 092, 144,
 * 176, 179) — rather than a percentage-shaped `DECIMAL(5,2)`. A tighter cap
 * would read as a bound the router does not need help with (it rejects
 * anything outside 0..100), and would quietly make widening the action set the
 * schema change this file just argued it is not.
 *
 * Both adds go through knex's own `alterTable`, with no `ALGORITHM=` clause and
 * no `.after()`, exactly as migrations 174 and 189 added their columns to this
 * table: appending a nullable column and one with a literal default are both
 * `INSTANT`-eligible, and naming the algorithm explicitly would turn a table
 * that legitimately needs a rebuild (say, one that has exhausted its instant
 * row-version budget) into a hard failure rather than a slow migration. The
 * `ADD CONSTRAINT` reasoning above is about a statement that is *never*
 * instant; these two are a different case.
 *
 * NOT NULL DEFAULT 'no_benefit' on the action, nullable on the value: "no
 * benefit" is the only sensible state for every assignment that exists today,
 * and a NULL value is how "no benefit" says it has no percentage. Nothing
 * changes what it bills when this runs.
 *
 * `down()` is lossy — a personal discount is agreed with a member and cannot be
 * reconstructed from the catalogue — so `docs/go-to-production.md` carries the
 * "capture them before rolling back" item, as migration 175's does.
 */

const ACTION_COLUMN = 'personal_fee_benefit_action';
const VALUE_COLUMN = 'personal_fee_benefit_value';

exports.up = async (knex) => {
  // Separate `hasColumn` guards: two non-transactional DDL statements, so a
  // crash between them must leave a re-run able to finish the second
  // (migrations 173/174/189 for precedent).
  if (!(await knex.schema.hasColumn('user_memberships', ACTION_COLUMN))) {
    await knex.schema.alterTable('user_memberships', (t) => {
      t.string(ACTION_COLUMN, 30).notNullable().defaultTo('no_benefit');
    });
  }
  if (!(await knex.schema.hasColumn('user_memberships', VALUE_COLUMN))) {
    await knex.schema.alterTable('user_memberships', (t) => {
      t.decimal(VALUE_COLUMN, 10, 2).nullable();
    });
  }
};

exports.down = async (knex) => {
  for (const column of [VALUE_COLUMN, ACTION_COLUMN]) {
    if (await knex.schema.hasColumn('user_memberships', column)) {
      await knex.schema.alterTable('user_memberships', (t) => t.dropColumn(column));
    }
  }
};
