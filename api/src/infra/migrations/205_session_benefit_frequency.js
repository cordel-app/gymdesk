/**
 * #918 — a Session Benefit carries a **Frequency**: the period on which the
 * included sessions are renewed ("2 Personal Training Classes per week").
 *
 * The column goes on exactly two tables, and for the reason every other
 * benefit-side column of this shape goes on two (migration 203):
 *
 *   membership_plan_session   — what the Plan is configured with (migration 173)
 *   user_membership_session   — what the assignment was agreed with (migration 174)
 *
 * The assignment side is not optional. Billing reads the **Assigned Plan
 * snapshot** and never the live catalogue (CLAUDE.md, #635 §13–§17), so a
 * Frequency that reached only the Plan table would be a configuration no
 * existing assignment could have been agreed with — and a Plan edited later
 * would move what an existing member is entitled to.
 *
 * **Nullable, with no default, and no backfill.** `NULL` is the dropdown's `—`
 * and is what every row written before this ticket means: a one-time allowance
 * of N sessions, charged once on the assignment's start date, which is exactly
 * what `buildItemSingleCharge()` has always projected. An explicit `once` means
 * the same thing but says so deliberately, so the two are kept distinct rather
 * than collapsed by a `DEFAULT 'once'` that would claim every historical row
 * had been configured.
 *
 * **Its own accepted set, not the Sellable Item's.** `week` is offered here
 * although #821 retired it from `gym_charges.billing_frequency`: how often an
 * allowance *renews* and how often an item is *priced* are different questions,
 * and the #918 thread's Q2 answer picks weekly as the case the field exists for.
 * `per_session` is not a period and is not accepted. The list lives once in
 * `api/src/domain/sessionBenefitFrequency.ts`, is mirrored here and is mirrored
 * again for the browser in `apps/admin/src/lib/sessionBenefitFrequency.ts`, so a
 * new value goes in **three** places — that module, the CHECK below, and the
 * admin mirror. `session-benefit-frequency.unit.test.ts` asserts the first two
 * agree by reading both back, and `session-benefit-frequency-ui.test.ts` the
 * third.
 *
 * Not to be confused with migration 174's `chk_<table>_item_frequency`, which
 * guards `item_billing_frequency` — the *Sellable Item's* own billing frequency,
 * frozen onto the same `user_membership_session` row. Two different columns, two
 * different questions, two CHECKs one word apart.
 *
 * The CHECK is affordable here because both columns are new: there is no
 * existing row for it to reject, and `ADD CONSTRAINT` rebuilding these two
 * tables under `ALGORITHM=COPY` is the same cost migration 203 already paid for
 * them. (`user_memberships` itself is the table CLAUDE.md keeps CHECK-free, for
 * its size — these are the small per-assignment benefit tables beside it.)
 *
 * Every statement is guarded on its own: MySQL commits DDL implicitly, so a
 * crash between the add and the CHECK must not leave a re-run skipping the
 * CHECK (migrations 134/140/155/173/203).
 *
 * **`down` refuses to drop a Frequency an assignment was agreed with**, the way
 * migration 203 refuses on its snapshot-bearing side, and for a neighbouring
 * reason. `user_membership_session.frequency` is Assigned Plan snapshot data —
 * what the member was promised — and `NULL` means *a one-time allowance*. A
 * `down` followed by an `up` therefore does not merely forget the value, it
 * silently rewrites "2 sessions every week" as "2 sessions, once", which the
 * projection and every display would then report. The catalogue side
 * (`membership_plan_session`) is re-enterable configuration and drops freely —
 * which is why the refusal is a pass of its own before any drop runs: DDL
 * commits implicitly, so refusing halfway would leave the catalogue column gone
 * and the migration still recorded as applied.
 */

// Mirrors `SESSION_BENEFIT_FREQUENCIES` in
// `api/src/domain/sessionBenefitFrequency.ts` — exported so the unit test can
// assert the two agree.
const SESSION_BENEFIT_FREQUENCIES = ['once', 'week', 'four_weeks', 'month', 'year'];

const TABLES = ['membership_plan_session', 'user_membership_session'];

async function constraintExists(knex, table, name) {
  const [[row]] = await knex.raw(
    `SELECT COUNT(*) AS cnt FROM information_schema.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ?`,
    [table, name],
  );
  return row.cnt > 0;
}

exports.up = async (knex) => {
  const quoted = SESSION_BENEFIT_FREQUENCIES.map((f) => `'${f}'`).join(', ');
  for (const table of TABLES) {
    if (!(await knex.schema.hasColumn(table, 'frequency'))) {
      await knex.schema.alterTable(table, (t) => {
        t.string('frequency', 20).nullable();
      });
    }

    const checkName = `chk_${table}_frequency`;
    if (!(await constraintExists(knex, table, checkName))) {
      await knex.raw(
        `ALTER TABLE \`${table}\` ADD CONSTRAINT ${checkName}
           CHECK (\`frequency\` IS NULL OR \`frequency\` IN (${quoted}))`,
      );
    }
  }
};

exports.down = async (knex) => {
  // The refusal is its own pass, *before* anything is dropped. DDL commits
  // implicitly, so a check interleaved with the drops would have already dropped
  // the catalogue column by the time it refused on the assignment one — leaving
  // the schema half rolled back with the migration still recorded as run.
  const assignmentTable = 'user_membership_session';
  if (await knex.schema.hasColumn(assignmentTable, 'frequency')) {
    const [[configured]] = await knex.raw(
      `SELECT COUNT(*) AS cnt FROM \`${assignmentTable}\` WHERE \`frequency\` IS NOT NULL`,
    );
    if (configured.cnt > 0) {
      throw new Error(
        `${assignmentTable} holds ${configured.cnt} agreed renewal frequenc(ies) — refusing to drop them. `
        + 'Re-applying this migration would reinstate the column empty, which reads as a '
        + 'one-time allowance for every one of them. Clear them deliberately first.',
      );
    }
  }

  for (const table of TABLES) {
    const checkName = `chk_${table}_frequency`;
    // MySQL 8 refuses to drop a column a CHECK still references (migration
    // 199), so the constraint goes first.
    if (await constraintExists(knex, table, checkName)) {
      await knex.raw(`ALTER TABLE \`${table}\` DROP CHECK ${checkName}`);
    }
    if (await knex.schema.hasColumn(table, 'frequency')) {
      await knex.schema.alterTable(table, (t) => t.dropColumn('frequency'));
    }
  }
};

exports.SESSION_BENEFIT_FREQUENCIES = SESSION_BENEFIT_FREQUENCIES;
exports.TABLES = TABLES;
