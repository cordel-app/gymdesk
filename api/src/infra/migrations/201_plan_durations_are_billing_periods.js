/**
 * #892 — a Membership Plan's durations are counts of its **Billing Frequency
 * periods**, not calendar months.
 *
 * Migration 173 gave `membership_plans` a `free_months` / `paid_months` /
 * `bonus_months` trio (189 added `pay_beforehand_months`), and 174 froze the
 * same four onto every assignment. The names were honest about what read them:
 * `classifyPlanDurationPeriod()` stepped `advanceBillingDate(startsAt, n,
 * 'month')` with the unit hard-coded, so a Plan billing every 4 weeks with
 * "Paid Duration 2" ran its paid stretch for two *calendar months* while
 * charging on a 28-day cycle. #892 makes the number a count of the Plan's own
 * cadence ("2 × 4 Weeks"), so the column name is now wrong in exactly the way
 * the ticket is about, and it is renamed on both tables:
 *
 *     free_months           -> free_periods
 *     paid_months           -> paid_periods
 *     pay_beforehand_months -> pay_beforehand_periods
 *     bonus_months          -> bonus_periods
 *
 * **No value changes and nothing is reinterpreted at rest** (§6, §7): the
 * stored numbers are the same numbers, and a Plan on the Month cadence — every
 * Plan that has never been switched to 4 Weeks — bills exactly as before,
 * because 1 × month *is* a month. What changes is the unit the code counts them
 * in, and that is a code change (`domain/planDuration.ts`), not a data one.
 *
 * `promotions` keeps its own `free_months` / `paid_months` / `bonus_months` /
 * `pay_beforehand_months` (migrations 102 / 141) untouched, and so do the
 * `user_membership_promotions` snapshots of them: a Promotion has no cadence of
 * its own and its timeline is still measured in calendar months. The ticket is
 * explicit that Promotions are out of scope.
 *
 * ── Why the CHECK is dropped and re-added ────────────────────────────────────
 *
 * Migration 189 added `chk_membership_plans_pay_beforehand_months`
 * (`pay_beforehand_months <= COALESCE(paid_months, 0)`). MySQL refuses to
 * rename a column a CHECK constraint names (ER_DEPENDENT_BY_CHECK_CONSTRAINT),
 * so the constraint goes first and comes back under its new name over the new
 * columns. The rule it enforces is unchanged.
 *
 * `ALTER TABLE ... RENAME COLUMN` is an in-place metadata change in MySQL 8 —
 * no table rebuild — which is what makes this safe to run against
 * `user_memberships`, the table migrations 174 and 189 both declined to rebuild
 * under `ALGORITHM=COPY`. That claim is *pinned* rather than assumed:
 * `ALGORITHM=INPLACE, LOCK=NONE` makes a server that cannot do it in place fail
 * the migration before touching a row, instead of silently rebuilding the
 * busiest table in the schema under a lock (migration 182's rule). Adding the
 * CHECK back touches `membership_plans` only, exactly as 189 did.
 *
 * Every step is guarded by its own information_schema lookup: these are
 * separate non-transactional DDL statements, so a crash between two of them
 * must leave a re-run able to finish the rest (173 / 189 for precedent). Each
 * table's four renames go in a **single** `ALTER`, for migration 189's reason —
 * cheaper and strictly more atomic, since a half-renamed `user_memberships` is
 * a state no build of the API can serve. Between the `DROP CHECK` and the
 * `ADD CONSTRAINT` the pre-paid bound is briefly unenforced; a re-run restores
 * it, and `toPlanDuration()` clamps whatever it reads either way.
 *
 * `down()` is value-safe only until a 4-weekly Plan's durations are first
 * edited under the new rule: from that point the stored number means
 * "N × 4 weeks", and the pre-#892 build a rollback restores would read it as N
 * calendar months. Capture `SELECT id, gym_id, free_periods, paid_periods,
 * pay_beforehand_periods, bonus_periods FROM membership_plans` before rolling
 * back, the way 189's go-to-production item captures `billing_policies`.
 */

const RENAMES = [
  ['free_months', 'free_periods'],
  ['paid_months', 'paid_periods'],
  ['pay_beforehand_months', 'pay_beforehand_periods'],
  ['bonus_months', 'bonus_periods'],
];

const TABLES = ['membership_plans', 'user_memberships'];

const OLD_CHECK = 'chk_membership_plans_pay_beforehand_months';
const NEW_CHECK = 'chk_membership_plans_pay_beforehand_periods';

async function constraintExists(knex, table, name) {
  const [[row]] = await knex.raw(
    `SELECT COUNT(*) AS cnt FROM information_schema.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ?`,
    [table, name],
  );
  return row.cnt > 0;
}

async function renameColumns(knex, pairs) {
  for (const table of TABLES) {
    const pending = [];
    for (const [from, to] of pairs) {
      const hasFrom = await knex.schema.hasColumn(table, from);
      const hasTo = await knex.schema.hasColumn(table, to);
      // Neither name present is schema drift, not a re-run: skipping it here
      // would let the ADD CONSTRAINT below fail on an unknown column *after*
      // the other tables had already been renamed.
      if (!hasFrom && !hasTo) {
        throw new Error(`201: ${table} has neither \`${from}\` nor \`${to}\` — schema is not at migration 189.`);
      }
      // Already renamed by an earlier, interrupted run: a no-op, not an error.
      if (hasFrom && !hasTo) pending.push(`RENAME COLUMN \`${from}\` TO \`${to}\``);
    }
    if (pending.length > 0) {
      await knex.raw(`ALTER TABLE \`${table}\` ${pending.join(', ')}, ALGORITHM=INPLACE, LOCK=NONE`);
    }
  }
}

exports.up = async (knex) => {
  if (await constraintExists(knex, 'membership_plans', OLD_CHECK)) {
    await knex.raw(`ALTER TABLE membership_plans DROP CHECK ${OLD_CHECK}`);
  }

  await renameColumns(knex, RENAMES);

  if (!(await constraintExists(knex, 'membership_plans', NEW_CHECK))) {
    await knex.raw(
      `ALTER TABLE membership_plans ADD CONSTRAINT ${NEW_CHECK}
       CHECK (pay_beforehand_periods IS NULL OR pay_beforehand_periods <= COALESCE(paid_periods, 0))`,
    );
  }
};

exports.down = async (knex) => {
  if (await constraintExists(knex, 'membership_plans', NEW_CHECK)) {
    await knex.raw(`ALTER TABLE membership_plans DROP CHECK ${NEW_CHECK}`);
  }

  await renameColumns(knex, RENAMES.map(([from, to]) => [to, from]));

  if (!(await constraintExists(knex, 'membership_plans', OLD_CHECK))) {
    await knex.raw(
      `ALTER TABLE membership_plans ADD CONSTRAINT ${OLD_CHECK}
       CHECK (pay_beforehand_months IS NULL OR pay_beforehand_months <= COALESCE(paid_months, 0))`,
    );
  }
};
