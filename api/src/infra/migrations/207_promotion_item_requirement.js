/**
 * #959 — a Sellable Item configured inside a **Promotion** carries a
 * **Requirement**: `mandatory` (the member takes it with the Promotion) or
 * `optional` (the member may decline it when the Promotion is assigned).
 *
 * The column goes on six tables, and for the reason migration 203 put the
 * `(action, value)` pair on the same six:
 *
 *   promotion_session / _oneoff / _periodical                       (migration 155)
 *   user_membership_promotion_{session,oneoff,periodical}_snapshot   (156/174)
 *
 * The assignment side is not optional. An application prices and reports from
 * its own snapshot and never from the live `promotion_*` row (CLAUDE.md, #635
 * §16), so a Requirement that reached only the catalogue would be a
 * configuration no existing application could have been agreed with — and the
 * screen that will offer the member the choice would read a Promotion that may
 * have been edited since.
 *
 * **Promotion side only.** The issue also asks for the flag on Membership Plan
 * items; the owner's answer on the thread excludes Plans outright ("Exclude
 * Membership plans from this ticket"), so `membership_plan_*` and
 * `user_membership_{session,oneoff,periodical}` are deliberately untouched here
 * rather than given a column nothing writes. The Membership Fee Benefit
 * (`promotion_membership_fee_benefits`) is excluded for the same reason — the
 * thread's Q3 answer is "No" — and it could not carry the flag honestly anyway:
 * it is a singleton with no Sellable Item, and a fee nobody may decline is not a
 * Requirement, it is the absence of one.
 *
 * **NOT NULL, defaulted and backfilled to `mandatory`, in one statement.**
 * `mandatory` is what every row already stored means: an applied Promotion
 * grants everything it configures, and nothing in the product offers the member
 * a choice today. A default of `optional` would make a promise about every
 * historical row that the assignment process does not yet keep. Adding the
 * column with that default fills every existing row in the same statement, so
 * there is no window in which it is nullable and a concurrent insert could leave
 * a NULL behind (the shape migration 203's header argues for) — and unlike 203
 * the default is *kept*, because here the backfill value and the new-row default
 * are the same answer.
 *
 * The accepted set lives once in `api/src/domain/promotionItemRequirement.ts`,
 * is mirrored below and is mirrored again for the browser in
 * `apps/admin/src/lib/promotionItemRequirement.ts`, so a new value goes in
 * **three** places — that module, the CHECK here, and the admin mirror.
 * `promotion-item-requirement.unit.test.ts` asserts the first two agree by
 * reading both back, and `promotion-item-requirement-ui.test.ts` the third.
 *
 * `ADD CONSTRAINT` rebuilds these tables under `ALGORITHM=COPY`, which is the
 * same cost migration 203 already paid for exactly these six; the CHECK is
 * affordable because the column is new and no existing row can violate it. (The
 * tables CLAUDE.md keeps CHECK-free are `user_memberships` and `gym_charges` —
 * these are the small per-Promotion and per-application benefit tables beside
 * them.) Both statements per table are guarded on their own: MySQL commits DDL
 * implicitly, so a crash between the add and the CHECK must not leave a re-run
 * skipping the CHECK (migrations 134/140/155/173/203/205).
 *
 * **`down` refuses to drop a configured Requirement, on all six tables** — which
 * is migration 203's rule on these same six and not 205's narrower one, because
 * the difference between them is *nullability*, not which side of the snapshot a
 * table is on. 205's catalogue column is nullable with no default, so a `down`
 * followed by an `up` leaves `NULL` there and claims nothing. This column is NOT
 * NULL with a default, so the same cycle does not merely forget a gym's
 * `optional` lines, it affirmatively rewrites every one of them as `mandatory` —
 * in the catalogue the editor reads back as much as in the snapshot the member
 * was shown, and `mandatory` and `optional` are opposite promises (which is also
 * why `parsePromotionItemRequirementInput()` 400s rather than coercing). The
 * refusal is a pass of its own *before* any drop runs: DDL commits implicitly, so
 * refusing halfway would leave some columns gone with the migration still
 * recorded as applied.
 *
 * One thing to know before adding another column to these tables: the longest
 * CHECK name here, `chk_user_membership_promotion_periodical_snapshot_requirement`,
 * is 61 of MySQL's 64 identifier characters. `chk_<table>_<column>` is the
 * convention CLAUDE.md and 203 use on exactly these tables, so it stays — but a
 * column whose name is longer than `requirement` cannot carry one, which is why
 * migration 156 abbreviates its own index names to `ump_periodical_snap_*`.
 */

// Mirrors `PROMOTION_ITEM_REQUIREMENTS` in
// `api/src/domain/promotionItemRequirement.ts` — exported so the unit test can
// assert the two agree.
const PROMOTION_ITEM_REQUIREMENTS = ['mandatory', 'optional'];

/** Mirrors `DEFAULT_PROMOTION_ITEM_REQUIREMENT`. See the header. */
const DEFAULT_REQUIREMENT = 'mandatory';

/** The Promotion's own configuration — re-enterable, so `down` drops it freely. */
const DEFINITION_TABLES = [
  'promotion_session',
  'promotion_oneoff',
  'promotion_periodical',
];

/** What an application was agreed with (#635 §16) — `down` refuses to drop a configured one. */
const SNAPSHOT_TABLES = [
  'user_membership_promotion_session_snapshot',
  'user_membership_promotion_oneoff_snapshot',
  'user_membership_promotion_periodical_snapshot',
];

const TABLES = [...DEFINITION_TABLES, ...SNAPSHOT_TABLES];

async function constraintExists(knex, table, name) {
  const [[row]] = await knex.raw(
    `SELECT COUNT(*) AS cnt FROM information_schema.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ?`,
    [table, name],
  );
  return row.cnt > 0;
}

exports.up = async (knex) => {
  const quoted = PROMOTION_ITEM_REQUIREMENTS.map((r) => `'${r}'`).join(', ');
  for (const table of TABLES) {
    // One statement: the column, its default and the backfill of every existing
    // row, which here are all the same value. See the header.
    if (!(await knex.schema.hasColumn(table, 'requirement'))) {
      await knex.schema.alterTable(table, (t) => {
        t.string('requirement', 20).notNullable().defaultTo(DEFAULT_REQUIREMENT);
      });
    }

    const checkName = `chk_${table}_requirement`;
    if (!(await constraintExists(knex, table, checkName))) {
      await knex.raw(
        `ALTER TABLE \`${table}\` ADD CONSTRAINT ${checkName}
           CHECK (\`requirement\` IN (${quoted}))`,
      );
    }
  }
};

exports.down = async (knex) => {
  // Both sides refuse, and the refusal is its own pass *before* anything is
  // dropped — DDL commits implicitly, so a check interleaved with the drops would
  // already have dropped the earlier tables' columns by the time it refused on a
  // later one. See the header for why the catalogue side refuses too: this column
  // is NOT NULL with a default, so a re-`up` rewrites `optional` as `mandatory`
  // rather than leaving it empty the way 205's nullable column does.
  for (const table of TABLES) {
    if (!(await knex.schema.hasColumn(table, 'requirement'))) continue;
    const [[configured]] = await knex.raw(
      `SELECT COUNT(*) AS cnt FROM \`${table}\` WHERE \`requirement\` <> ?`,
      [DEFAULT_REQUIREMENT],
    );
    if (configured.cnt > 0) {
      throw new Error(
        `${table} holds ${configured.cnt} item requirement(s) other than '${DEFAULT_REQUIREMENT}' `
        + '— refusing to drop them. Re-applying this migration would call every one of them '
        + `'${DEFAULT_REQUIREMENT}', which tells the member the opposite of what was configured. `
        + 'Clear them deliberately first (see migration 207).',
      );
    }
  }

  for (const table of TABLES) {
    const checkName = `chk_${table}_requirement`;
    // MySQL 8 refuses to drop a column a CHECK still references (migration 199),
    // so the constraint goes first.
    if (await constraintExists(knex, table, checkName)) {
      await knex.raw(`ALTER TABLE \`${table}\` DROP CHECK ${checkName}`);
    }
    if (await knex.schema.hasColumn(table, 'requirement')) {
      await knex.schema.alterTable(table, (t) => t.dropColumn('requirement'));
    }
  }
};

exports.PROMOTION_ITEM_REQUIREMENTS = PROMOTION_ITEM_REQUIREMENTS;
exports.DEFAULT_REQUIREMENT = DEFAULT_REQUIREMENT;
exports.DEFINITION_TABLES = DEFINITION_TABLES;
exports.SNAPSHOT_TABLES = SNAPSHOT_TABLES;
exports.TABLES = TABLES;
