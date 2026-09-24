/**
 * #635 stage 4 (part 2): retire **Included Services**.
 *
 * §1 of the ticket: "Remove the existing Included Services concept from
 * Membership Plans [and] Assigned Membership Plans ... Do not rename it or move
 * it somewhere else." Part 1 (migration 176) retired Charge Benefits and left
 * this one open, because `plan_allowances` was not a commercial concept — it was
 * **booking access**, and the ticket's replacement (Session Benefits) is keyed
 * to a Sellable Item while an allowance is keyed to an activity type, so §18
 * would not accept the reinterpretation.
 *
 * That question was answered on the issue:
 *
 *   "the relation should be [the other way] around. Activity type should flag
 *    [which] membership plans are enabled to attend [a] certain activity type.
 *    In activity type we will store that only people with the plan 'Yoga Plan'
 *    can book Yoga Activity type. So Included services can be completely
 *    removed."
 *
 * That inverted relation already exists: `activity_type_eligible_plans`
 * (migration 139, #481) is exactly "which Membership Plans may book this
 * Activity Type", it is editable from the Activity Types page, and
 * `activity-eligibility.ts` already gates every booking on it. So booking
 * access survives this drop intact — it simply stops being configurable from
 * two sides at once.
 *
 * §18 asks what read `plan_allowances` before it is deleted:
 *
 *   - **Booking access** (`plan-allowances.ts`). Its activity-type gate is
 *     `activity_type_eligible_plans`' job from now on. The *center* coverage
 *     check that shared the same hook is not part of Included Services and
 *     moves to `plan-center-access.ts` unchanged.
 *   - **Class packages** (`package-credits.ts`). Used the table to decide
 *     whether an activity type was plan-restricted at all; it now asks
 *     `isActivityTypeEligibleForMember()` the same question, so a member whose
 *     plan does not cover an activity can still pay for it out of a class
 *     package exactly as before.
 *   - **Billing.** Nothing, ever: an allowance carried no price. Since stage 3
 *     (#714) every surface that prices an assignment reads its own snapshot.
 *   - **Display only** — the `INCLUDED SERVICES` section on the Plans page, the
 *     BENEFITS list on the Assigned Plan card (now the assignment's #635
 *     snapshot), the Membership Plan card on the Member page, and the
 *     `session_count` "unused value" warning on POST /user-memberships/:id/close.
 *     All removed in this PR.
 *
 * The one behaviour that genuinely goes away is the **`session_count` cap**: an
 * allowance could limit a member to N bookings of an activity type per
 * recurrence window, and eligibility has no equivalent. Q1/Q4 on the issue were
 * answered "So Included services can be completely removed", and §1 forbids
 * moving the concept elsewhere, so the cap is not reproduced in a side table —
 * a Plan's Session Benefits are how a bounded quantity is expressed now.
 *
 * `down` recreates the table empty, carrying migration 061's columns (its two
 * ENUMs restored as VARCHAR + a named CHECK, which is the convention now). The
 * rows are gone for good and deliberately not archived: Q3 answered that
 * existing assignments may simply be hard-deleted, nothing bills off an
 * allowance, and a table nothing can read would be schema cruft.
 *
 * So `down` restores the *shape* only. Rolling the API back to a build that
 * still gates bookings on this table would find it empty and refuse every
 * plan-based booking, so a behavioural rollback also needs the pre-deploy row
 * dump reloaded — see `docs/go-to-production.md`, which carries both that and
 * the forward ordering rule: as for migration 176, run this *after* the API
 * build that stops reading the table is live, or the previous build 500s on
 * `ER_NO_SUCH_TABLE`.
 */

exports.up = async (knex) => {
  await knex.schema.dropTableIfExists('plan_allowances');
};

// CREATE TABLE and each ADD CONSTRAINT are separate non-transactional
// statements, so one hasTable() guard around all of them would let a crash
// mid-way leave a re-run skipping the constraints for good. Each is guarded on
// its own, the way migrations 089, 173 and 176 do it.
const hasConstraint = async (knex, table, name) => {
  const [rows] = await knex.raw(
    `SELECT COUNT(*) AS cnt FROM information_schema.TABLE_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ?`,
    [table, name],
  );
  return Number(rows[0].cnt) > 0;
};

exports.down = async (knex) => {
  if (!(await knex.schema.hasTable('plan_allowances'))) {
    await knex.schema.createTable('plan_allowances', (t) => {
      t.increments('id').unsigned().primary();
      t.specificType('gym_id', 'char(36)').notNullable();
      t.integer('membership_plan_id').unsigned().notNullable();
      t.integer('activity_type_id').unsigned().notNullable();
      t.string('allowance_type', 20).notNullable().defaultTo('unlimited');
      t.integer('session_count').unsigned().nullable();
      t.integer('recurrence_interval').unsigned().nullable();
      t.string('recurrence_unit', 10).nullable();
      t.datetime('created_at').notNullable().defaultTo(knex.raw('(UTC_TIMESTAMP())'));
    });
  }

  const constraints = [
    ['plan_allowances_gym_id_foreign',
     'ADD CONSTRAINT `plan_allowances_gym_id_foreign` FOREIGN KEY (`gym_id`) REFERENCES `gyms` (`id`) ON DELETE CASCADE'],
    ['plan_allowances_membership_plan_id_foreign',
     'ADD CONSTRAINT `plan_allowances_membership_plan_id_foreign` FOREIGN KEY (`membership_plan_id`) REFERENCES `membership_plans` (`id`) ON DELETE CASCADE'],
    ['plan_allowances_activity_type_id_foreign',
     'ADD CONSTRAINT `plan_allowances_activity_type_id_foreign` FOREIGN KEY (`activity_type_id`) REFERENCES `activity_types` (`id`) ON DELETE CASCADE'],
    ['plan_allowances_membership_plan_id_activity_type_id_unique',
     'ADD CONSTRAINT `plan_allowances_membership_plan_id_activity_type_id_unique` UNIQUE (`membership_plan_id`, `activity_type_id`)'],
    ['chk_plan_allowances_allowance_type',
     "ADD CONSTRAINT chk_plan_allowances_allowance_type CHECK (allowance_type IN ('unlimited','session_count'))"],
    ['chk_plan_allowances_recurrence_unit',
     "ADD CONSTRAINT chk_plan_allowances_recurrence_unit CHECK (recurrence_unit IS NULL OR recurrence_unit IN ('day','week','month','year'))"],
  ];
  for (const [name, sql] of constraints) {
    if (!(await hasConstraint(knex, 'plan_allowances', name))) {
      await knex.raw(`ALTER TABLE plan_allowances ${sql}`);
    }
  }
};
