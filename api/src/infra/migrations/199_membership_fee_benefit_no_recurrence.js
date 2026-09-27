/**
 * #814: the Membership Fee Promotion loses its recurrence fields.
 *
 * `promotion_membership_fee_benefits` (migration 179) was created with the
 * shape the section had always been *edited* in, not the shape billing needs.
 * Migration 179's own comment says so:
 *
 *     // Carried over from the Period Benefit shape the section has always
 *     // been edited in (quantity × frequency is displayed and saved by the
 *     // Membership Fee editor); `action`/`value` are what billing applies.
 *
 * `quantity`, `frequency_interval` and `frequency_unit` come from
 * `promotion_period_benefits` (migration 093), a table built for per-charge-type
 * quantities — "2 sessions every 3 months". Applied to the membership fee they
 * mean nothing: there is exactly one membership fee per assignment and its
 * cadence is the assignment's own Billing frequency (`ASSIGNMENT_CADENCE`,
 * migration 189), never a Promotion's. The Promotion editor rendered all three
 * anyway, which is the redundancy this ticket removes.
 *
 * ── §18-style accounting: what read them, and why nothing does now ──────────
 *
 * Before this PR, every reader of the three columns:
 *
 *   - `validateMembershipFeeBenefit()` + the singleton `PUT
 *     /promotions/:id/membership-fee-benefit` (`api/src/api/promotion-details.ts`)
 *     — required `quantity`/`frequency_interval` to be positive integers and
 *     `frequency_unit` to be `week`/`month`, then persisted whatever came in.
 *   - `POST /promotions/:id/duplicate` (`api/src/api/promotions.ts`) — copied
 *     them onto the copy.
 *   - `fetchLiveBenefits()` (`api/src/api/membership-promotions.ts`) — selected
 *     them and froze them onto `user_membership_promotions.snapshot`.
 *   - The Promotion editor (`apps/admin/.../promotions/page.tsx`) — three form
 *     controls and two read-only cells.
 *
 * None of those is a pricing path. What decides what an applied Promotion does
 * to the Membership Fee is `resolveMembershipFee()` over
 * `MembershipFeeBenefit` (`api/src/domain/promotionApplication.ts`), whose four
 * fields are `action`, `value`, `enabled` and `durationMonths` — the same four
 * `loadStandingApplicationsForPricing()` and `loadPromotionApplications()` map
 * out of the snapshot. The three columns dropped here reached the fee
 * arithmetic through nothing at all: they were written, read back into the
 * snapshot JSON, displayed, and never consulted. So removing them takes no
 * behaviour with it, in the same way migration 177 removed `plan_allowances`.
 *
 * Existing rows keep working because the surviving columns are untouched: the
 * `action`/`value`/`enabled`/`duration_months` of every configured Promotion is
 * exactly what it was, and every Assigned Plan prices as it did. Snapshots
 * already written keep their `quantity`/`frequency_interval`/`frequency_unit`
 * keys — `membershipFeeBenefitsFromSnapshot()` returns the stored objects as
 * they are and no caller looks at those keys — so no historical snapshot is
 * rewritten and no assignment re-prices.
 *
 * The two CHECK constraints go with the columns, because that is all they
 * constrained (`chk_pmfb_positive` is `quantity > 0 AND frequency_interval > 0`,
 * `chk_pmfb_frequency_unit` is `frequency_unit IN ('week','month')`). MySQL 8
 * refuses to drop a column a CHECK still references, so they are dropped first.
 * `chk_pmfb_action` stays — `action` stays.
 *
 * Forward ordering, as for migrations 176/177/179/197: run this *after* the API
 * build that stops writing the columns is live, or the previous build's INSERT
 * answers `ER_BAD_FIELD_ERROR` on every Membership Fee Benefit save and on
 * duplicating a Promotion. `.github/workflows/deploy.yml` runs
 * `knex migrate:latest` before restarting the API container — in the same job,
 * before the restart — so a single deploy cannot honour that order: the API
 * change has to merge in a commit carrying no new migration, and this file in a
 * second one. `docs/go-to-production.md` carries the checklist item.
 *
 * What makes API-first possible is the other direction, and it is the
 * non-obvious half: the new build is safe against the **old** schema. It omits
 * all three columns from its INSERT and migration 179 gave each a NOT NULL
 * DEFAULT (`1` / `1` / `'month'`), so MySQL fills them even under STRICT mode.
 * The old build against the new schema is the only broken combination.
 *
 * `down()` puts the three columns back in the shape migration 179 left them —
 * NOT NULL with the same defaults, so every existing row reads `1 / 1 / month`,
 * which is what an editor that no longer offers the fields would have written
 * anyway — and restores both CHECKs. Nothing is lost by the rollback that the
 * defaults do not supply, since nothing priced on them. Two cosmetic notes on
 * the rolled-back shape: the columns are appended rather than restored to their
 * old position between `promotion_id` and `duration_months`, and their values
 * are the defaults rather than what they held. Neither matters — nothing reads
 * this table by ordinal (mysql2 returns name-keyed objects) and nothing priced
 * on the values — but a schema diff after a 179 → 199 → 199-down round trip
 * will show the reordering, and it is not a bug.
 */

const hasColumn = (knex, column) =>
  knex.schema.hasColumn('promotion_membership_fee_benefits', column);

const hasConstraint = async (knex, name) => {
  const [rows] = await knex.raw(
    `SELECT COUNT(*) AS cnt FROM information_schema.TABLE_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'promotion_membership_fee_benefits'
       AND CONSTRAINT_NAME = ?`,
    [name],
  );
  return Number(rows[0].cnt) > 0;
};

// Each statement is guarded on its own: DDL is not transactional in MySQL, so a
// migration that dies half way has to be re-runnable (the precedent set by
// migrations 155 / 173 / 176 / 179).
exports.up = async (knex) => {
  if (await hasConstraint(knex, 'chk_pmfb_positive')) {
    await knex.raw('ALTER TABLE promotion_membership_fee_benefits DROP CHECK chk_pmfb_positive');
  }
  if (await hasConstraint(knex, 'chk_pmfb_frequency_unit')) {
    await knex.raw('ALTER TABLE promotion_membership_fee_benefits DROP CHECK chk_pmfb_frequency_unit');
  }
  // One ALTER for whichever are still present, so a re-run after a crash has one
  // failure point rather than three.
  const present = [];
  for (const column of ['quantity', 'frequency_interval', 'frequency_unit']) {
    if (await hasColumn(knex, column)) present.push(column);
  }
  if (present.length > 0) {
    await knex.schema.alterTable('promotion_membership_fee_benefits', (t) => t.dropColumn(...present));
  }
};

exports.down = async (knex) => {
  if (!(await hasColumn(knex, 'quantity'))) {
    await knex.schema.alterTable('promotion_membership_fee_benefits', (t) => {
      t.integer('quantity').unsigned().notNullable().defaultTo(1);
    });
  }
  if (!(await hasColumn(knex, 'frequency_interval'))) {
    await knex.schema.alterTable('promotion_membership_fee_benefits', (t) => {
      t.integer('frequency_interval').unsigned().notNullable().defaultTo(1);
    });
  }
  if (!(await hasColumn(knex, 'frequency_unit'))) {
    await knex.schema.alterTable('promotion_membership_fee_benefits', (t) => {
      t.string('frequency_unit', 10).notNullable().defaultTo('month');
    });
  }
  if (!(await hasConstraint(knex, 'chk_pmfb_frequency_unit'))) {
    await knex.raw(
      'ALTER TABLE promotion_membership_fee_benefits ADD CONSTRAINT chk_pmfb_frequency_unit ' +
      "CHECK (frequency_unit IN ('week','month'))",
    );
  }
  if (!(await hasConstraint(knex, 'chk_pmfb_positive'))) {
    await knex.raw(
      'ALTER TABLE promotion_membership_fee_benefits ADD CONSTRAINT chk_pmfb_positive ' +
      'CHECK (quantity > 0 AND frequency_interval > 0)',
    );
  }
};
