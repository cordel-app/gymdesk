/**
 * #896 stage 1: a Sellable Item configured in a Promotion or a Membership Plan
 * carries a **pricing treatment**, not just a quantity.
 *
 * §15 puts the pair — `action` plus, when the action asks for one, `value` —
 * on the *relationship* between the Promotion/Plan and the Sellable Item, and
 * §12 forbids putting any of it on the global Sellable Item: the same
 * `gym_charges` row may be waived by one Plan and discounted 20% by a
 * Promotion, and the item itself learns nothing from either. So the columns go
 * on twelve tables and on nothing else:
 *
 *   Promotion side (five actions — §2)
 *     promotion_session / _oneoff / _periodical                    (migration 155)
 *     user_membership_promotion_{session,oneoff,periodical}_snapshot (156/174)
 *
 *   Membership Plan side (three actions — §5, §16)
 *     membership_plan_session / _oneoff / _periodical              (migration 173)
 *     user_membership_session / _oneoff / _periodical              (migration 174)
 *
 * The snapshot tables get the pair for CLAUDE.md's Assigned Plan rule: billing
 * reads the assignment's own snapshot and never the live catalogue, so a pair
 * that reached only the catalogue tables would be a configuration an existing
 * assignment could never have been agreed with.
 *
 * **Two option sets, and the CHECK is what enforces the smaller one.** §16 is
 * explicit that "Membership Plans cannot configure `Fixed discount` or `Fixed
 * Price`", so the Plan-side CHECK permits three values and the Promotion-side
 * five. The lists live once in `api/src/domain/sellableItemBenefitActions.ts`
 * and are mirrored here; a new action goes in **two** places, which
 * `sellable-item-benefit-actions.unit.test.ts` asserts by reading both back.
 * The vocabulary itself is not new — it is `PromotionBenefitAction`
 * (`domain/promotionBenefits.ts`), already stored by
 * `promotion_membership_fee_benefits` under the same `action`/`value` column
 * names and the same `chk_..._action` convention (migration 179).
 *
 * **The default is neutral; the backfill is not.** §13 wants existing
 * configurations to keep their current pricing behaviour, and on the two sides
 * that means two different values:
 *
 *   - A **Plan** benefit is charged today at its own price, so `no_benefit` —
 *     the column default — already describes it. The backfill is a no-op.
 *   - A **Promotion** grant is an implicit *waive* today: `buildItemSingleCharge()`
 *     in `domain/billingSimulation.ts` charges `unit × (quantity − covered)`,
 *     and a periodical grant waives the periods it covers. Leaving those rows
 *     at `no_benefit` would, at stage 3, start charging members for items their
 *     Promotion currently gives them free. So every promotion-side row that
 *     exists when this migration runs is written to `waive`, which is what it
 *     already means. This is the #896 thread's Q1 answer ("Waive is the same as
 *     100% discount or in other words, free service"; "No promotion means that
 *     the sellable item Price will be applied") applied to data that predates
 *     the column.
 *
 * New rows still default to `no_benefit` per §13 — the backfill corrects
 * history, it is not the default.
 *
 * **Nothing reads the pair yet.** Stage 2 is the API: validation and
 * persistence on the six replace-all `PUT`s (including
 * `materialiseAssignedPlanSnapshot()`'s editing path). Stage 3 is the pricing
 * cutover in `domain/billingSimulation.ts`. Until stage 3 lands, every editor
 * writes without naming the column and gets the neutral default, which changes
 * nothing because no reader exists.
 *
 * The one thing stage 1 does wire is the **copy** writers, and it has to:
 * `snapshotPromotionGrants()` (`api/membership-promotions.ts`),
 * `snapshotAssignedPlan()` and `writeAssignedPlanBenefitSection()`
 * (`api/assigned-plan-snapshot.ts`) all name their columns explicitly, so a
 * Promotion applied after this migration and before stage 2 would snapshot
 * `no_benefit` while its source grant reads `waive` — and billing reads the
 * snapshot, never the live row. They carry the pair from this change on.
 *
 * **The add is a single statement per table, and the backfill is its default.**
 * `ADD COLUMN … NOT NULL DEFAULT '<what the rows already mean>'` fills every
 * existing row in the same statement, so there is no window in which the
 * column is nullable and a concurrent insert could leave a NULL behind (which
 * would then fail the tightening `MODIFY` under STRICT_TRANS_TABLES, after the
 * add had committed). The default is then demoted to `no_benefit` with
 * `ALTER COLUMN … SET DEFAULT`, which is metadata-only — no rebuild — and the
 * two CHECKs are added in one `ALTER` rather than two, so the migration costs
 * one `ALGORITHM=COPY` rebuild per table instead of three. Six of the twelve
 * grow per assignment, so that difference is the deploy window
 * (`docs/go-to-production.md`).
 *
 * Every statement is still guarded on its own — MySQL commits DDL implicitly,
 * so a crash between two must never leave a re-run skipping the rest
 * (migrations 134/140/155/173/174): the add on `hasColumn`, the demotion on
 * the default the column currently holds, each CHECK on its own name.
 *
 * **`down` refuses to drop a configured promotion-side treatment**, and that
 * is not politeness. The `waive` backfill is only correct against data that
 * predates the column, and it is the column that records it has run — so a
 * `down` followed by an `up`, after stage 2 has made the pair writable, would
 * hand every promotion-side row a 100% discount nobody configured. A rollback
 * of stage 1 itself is unaffected: every row is still `waive` there.
 *
 * Two omissions that are decided, not missed: `user_membership_services`
 * (Additional Periodic Services, migration 174 §4) carries a Sellable Item and
 * its frozen price but no pair, because §15 puts the configuration on the
 * Promotion/Plan *relationship* and an Additional Service is attached to the
 * assignment directly; and the CHECK bounds the value from below but not from
 * above — `DECIMAL(10,2)` is the upper bound, and `MAX_BENEFIT_AMOUNT` in the
 * domain module is that same limit spelled out for the 400.
 */

// Mirrors `PROMOTION_ITEM_ACTIONS` / `PLAN_BENEFIT_ACTIONS` in
// `api/src/domain/sellableItemBenefitActions.ts` — exported so the unit test
// can assert the two agree.
const PROMOTION_ACTIONS = ['no_benefit', 'waive', 'percentage_discount', 'fixed_discount', 'fixed_price'];
const PLAN_ACTIONS = ['no_benefit', 'waive', 'percentage_discount'];

const PROMOTION_TABLES = [
  'promotion_session',
  'promotion_oneoff',
  'promotion_periodical',
  'user_membership_promotion_session_snapshot',
  'user_membership_promotion_oneoff_snapshot',
  'user_membership_promotion_periodical_snapshot',
];

const PLAN_TABLES = [
  'membership_plan_session',
  'membership_plan_oneoff',
  'membership_plan_periodical',
  'user_membership_session',
  'user_membership_oneoff',
  'user_membership_periodical',
];

const DEFAULT_ACTION = 'no_benefit';

/** What a row written before the column existed already means. See the header. */
const BACKFILL_ACTION = { promotion: 'waive', plan: DEFAULT_ACTION };

/**
 * The value rule, per context: an action that takes no value must not carry
 * one, and one that does must — a percentage within 0..100, an amount not
 * negative. The same rule `benefitConfigError()` applies on the way in; this is
 * the backstop, and it is free here because both columns are new.
 */
function valueCheckExpression(actions) {
  const quoted = (list) => list.map((a) => `'${a}'`).join(', ');
  const valueless = actions.filter((a) => a === 'no_benefit' || a === 'waive');
  // `action` and `value` are both non-reserved words in MySQL 8, but they are
  // ordinary enough that every reference to them is backticked rather than
  // relying on that.
  const branches = [`(\`action\` IN (${quoted(valueless)}) AND \`value\` IS NULL)`];
  if (actions.includes('percentage_discount')) {
    branches.push("(`action` = 'percentage_discount' AND `value` IS NOT NULL AND `value` >= 0 AND `value` <= 100)");
  }
  const amounts = actions.filter((a) => a === 'fixed_discount' || a === 'fixed_price');
  if (amounts.length > 0) {
    branches.push(`(\`action\` IN (${quoted(amounts)}) AND \`value\` IS NOT NULL AND \`value\` >= 0)`);
  }
  return branches.join(' OR ');
}

async function constraintExists(knex, table, name) {
  const [[row]] = await knex.raw(
    `SELECT COUNT(*) AS cnt FROM information_schema.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ?`,
    [table, name],
  );
  return row.cnt > 0;
}

exports.up = async (knex) => {
  for (const [context, tables] of [['promotion', PROMOTION_TABLES], ['plan', PLAN_TABLES]]) {
    const actions = context === 'promotion' ? PROMOTION_ACTIONS : PLAN_ACTIONS;

    for (const table of tables) {
      // 1. The pair. The default at *add* time is what the rows already in the
      //    table mean, so existing rows are backfilled by the same statement
      //    and no NULL ever exists. Knex compiles the two column adds into one
      //    ALTER, so the single `hasColumn` guard covers both.
      if (!(await knex.schema.hasColumn(table, 'action'))) {
        await knex.schema.alterTable(table, (t) => {
          t.string('action', 30).notNullable().defaultTo(BACKFILL_ACTION[context]);
          t.decimal('value', 10, 2).nullable();
        });
      }

      // 2. From here on a new row starts neutral (§13). Metadata-only.
      const [[currentDefault]] = await knex.raw(
        `SELECT COLUMN_DEFAULT AS d FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = 'action'`,
        [table],
      );
      if (currentDefault == null || currentDefault.d !== DEFAULT_ACTION) {
        await knex.raw(
          `ALTER TABLE \`${table}\` ALTER COLUMN \`action\` SET DEFAULT '${DEFAULT_ACTION}'`,
        );
      }

      // 3. Both CHECKs in one ALTER — one rebuild, not two — while each name
      //    stays independently guarded so a crash between them still resumes.
      const actionCheck = `chk_${table}_action`;
      const valueCheck = `chk_${table}_value`;
      const haveAction = await constraintExists(knex, table, actionCheck);
      const haveValue = await constraintExists(knex, table, valueCheck);
      if (!haveAction || !haveValue) {
        const clauses = [];
        if (!haveAction) {
          clauses.push(
            `ADD CONSTRAINT ${actionCheck} `
            + `CHECK (\`action\` IN (${actions.map((a) => `'${a}'`).join(', ')}))`,
          );
        }
        if (!haveValue) {
          clauses.push(`ADD CONSTRAINT ${valueCheck} CHECK (${valueCheckExpression(actions)})`);
        }
        await knex.raw(`ALTER TABLE \`${table}\` ${clauses.join(', ')}`);
      }
    }
  }
};

exports.down = async (knex) => {
  for (const [context, tables] of [['promotion', PROMOTION_TABLES], ['plan', PLAN_TABLES]]) {
    for (const table of tables) {
      // A promotion-side row holding anything other than what the backfill
      // wrote is a treatment somebody configured. Dropping the column loses it,
      // and re-applying this migration would then call every row a `waive`.
      // See the header: refusing is the safe answer, and stage 1 itself rolls
      // back cleanly because every row is still `waive` there.
      if (context === 'promotion' && (await knex.schema.hasColumn(table, 'action'))) {
        const [[configured]] = await knex.raw(
          `SELECT COUNT(*) AS cnt FROM \`${table}\` WHERE \`action\` <> ?`,
          [BACKFILL_ACTION.promotion],
        );
        if (configured.cnt > 0) {
          throw new Error(
            `${table} holds ${configured.cnt} configured benefit action(s) — refusing to drop them. `
            + 'Clear them deliberately first (see migration 203).',
          );
        }
      }

      // MySQL 8 refuses to drop a column a CHECK still references (migration 199),
      // so the constraints go first.
      for (const name of [`chk_${table}_action`, `chk_${table}_value`]) {
        if (await constraintExists(knex, table, name)) {
          await knex.raw(`ALTER TABLE \`${table}\` DROP CHECK ${name}`);
        }
      }
      const present = [];
      for (const column of ['action', 'value']) {
        if (await knex.schema.hasColumn(table, column)) present.push(column);
      }
      if (present.length > 0) {
        await knex.schema.alterTable(table, (t) => t.dropColumn(...present));
      }
    }
  }
};

exports.PROMOTION_ACTIONS = PROMOTION_ACTIONS;
exports.PLAN_ACTIONS = PLAN_ACTIONS;
exports.PROMOTION_TABLES = PROMOTION_TABLES;
exports.PLAN_TABLES = PLAN_TABLES;
exports.DEFAULT_ACTION = DEFAULT_ACTION;
exports.BACKFILL_ACTION = BACKFILL_ACTION;
exports.valueCheckExpression = valueCheckExpression;
