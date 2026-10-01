/**
 * #926: a Promotion targets either a Membership Plan or a Sellable Item.
 *
 * Until now every Promotion was implicitly about a Membership Plan: it carried
 * a Membership Fee Benefit (`promotion_membership_fee_benefits`, migration 179)
 * and a set of Suitable Membership Plans (`promotion_membership_plans`), and
 * `applyPromotionToMembership()` is the only thing that consumes either. This
 * column makes that target explicit so the editor can hide the two
 * Plan-specific sections when a gym is configuring a Promotion on a Sellable
 * Item bought on its own.
 *
 * `NOT NULL DEFAULT 'membership_plan'` does the backfill in one statement:
 * every existing Promotion reads as what it already was, and an API client that
 * predates the column keeps creating Plan Promotions. That is the ticket's
 * "The default should preserve the existing behavior for current Promotions".
 *
 * **Nothing else moves.** The target is configuration, not a migration of data:
 * a Promotion switched to `sellable_item` keeps its Membership Fee Benefit row
 * and its `promotion_membership_plans` rows exactly as stored (§4 — "Changing
 * the target should not silently migrate or reinterpret existing
 * configuration"), and no apply, pricing or snapshot path reads this column in
 * this ticket. So there is no deploy-ordering split either: the new API build
 * selects `p.applies_to`, so the schema moves first, which is what
 * `.github/workflows/deploy.yml` already does (`knex migrate:latest` before the
 * API container restarts); the old build against the new schema never names the
 * column and the default fills it.
 *
 * The accepted set is declared once in `api/src/domain/promotionTarget.ts` and
 * mirrored by the CHECK below — a new target goes in those two places, as a new
 * lifecycle status does (migration 202). The CHECK is worth its cost here for
 * the reason migrations 093 and 202 paid it on this same table: `promotions` is
 * a small per-gym catalogue, nothing like the `user_memberships` rebuild
 * CLAUDE.md warns about, and the column is written by hand-built UPDATE
 * statements where a typo would otherwise be stored silently. `ADD CONSTRAINT
 * … CHECK` is `ALGORITHM=COPY` (MySQL refuses INPLACE), so this rebuilds the
 * table once under a metadata lock; the column add itself is INSTANT.
 */

/** MySQL: ER_CHECK_CONSTRAINT_NOT_FOUND — the only error a DROP CHECK may swallow. */
const ER_CHECK_CONSTRAINT_NOT_FOUND = 3940;

const TARGET_CHECK = 'chk_promotions_applies_to';
/** Mirrors PROMOTION_TARGETS in api/src/domain/promotionTarget.ts. */
const TARGETS = ['membership_plan', 'sellable_item'];

// Exported so `promotion-target.unit.test.ts` can `require()` this file and
// assert the CHECK admits exactly what the domain module accepts, the way
// migration 203 exports its own action sets. Without it the "two places" rule
// has no drift guard: a third target added to `PROMOTION_TARGETS` and to the
// admin mirror would pass every test and surface as a 500 on save.
exports.TARGETS = TARGETS;
exports.TARGET_CHECK = TARGET_CHECK;

exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('promotions', 'applies_to'))) {
    await knex.schema.alterTable('promotions', (t) => {
      t.string('applies_to', 32).notNullable().defaultTo('membership_plan');
    });
  }

  // Guarded by name so a crash between the two ALTERs still resumes, and
  // re-created rather than skipped when the clause has drifted from the set
  // above — a widening of an `IN` list cannot fail on existing rows, and every
  // row holds the default until something writes another value.
  const [[existing]] = await knex.raw(
    `SELECT cc.CHECK_CLAUSE AS clause
       FROM information_schema.CHECK_CONSTRAINTS cc
       JOIN information_schema.TABLE_CONSTRAINTS tc
         ON tc.CONSTRAINT_SCHEMA = cc.CONSTRAINT_SCHEMA
        AND tc.CONSTRAINT_NAME = cc.CONSTRAINT_NAME
      WHERE tc.TABLE_SCHEMA = DATABASE()
        AND tc.TABLE_NAME = 'promotions'
        AND cc.CONSTRAINT_NAME = ?`,
    [TARGET_CHECK],
  );
  // MySQL stores each literal with a charset prefix and escaped quotes
  // (`_utf8mb4\'sellable_item\'`), so the backslashes come off before matching.
  const clause = existing?.clause == null ? null : String(existing.clause).replace(/\\/g, '');
  if (clause != null && TARGETS.every((v) => clause.includes(`'${v}'`))) return;

  await knex.raw(`ALTER TABLE promotions DROP CHECK ${TARGET_CHECK}`).catch((err) => {
    if (err.errno !== ER_CHECK_CONSTRAINT_NOT_FOUND) throw err;
  });
  await knex.raw(
    `ALTER TABLE promotions ADD CONSTRAINT ${TARGET_CHECK} ` +
    `CHECK (applies_to IN (${TARGETS.map((v) => `'${v}'`).join(',')}))`,
  );
};

exports.down = async (knex) => {
  // Dropping the column would take every configured target with it, and a
  // Promotion a gym configured as `sellable_item` would come back as a
  // Membership Plan Promotion — Plan sections visible again, with no record that
  // it was ever anything else. That is the silent reinterpretation `up`'s note
  // refuses, so this refuses too, as migration 203's `down` refuses while a
  // configured benefit action exists: the target is configuration nobody can
  // reconstruct, and `down` is operator-invoked (`npm run db:migrate:down`),
  // never run by CI, so a refusal is read by the person who can act on it.
  if (await knex.schema.hasColumn('promotions', 'applies_to')) {
    const [[configured]] = await knex.raw(
      'SELECT COUNT(*) AS cnt FROM promotions WHERE applies_to <> ?',
      ['membership_plan'],
    );
    if (Number(configured.cnt) > 0) {
      throw new Error(
        `promotions holds ${configured.cnt} Promotion(s) targeting a Sellable Item — refusing to drop ` +
        '`applies_to`, because rolling back would silently turn them back into Membership Plan ' +
        'Promotions. Re-target them deliberately first, then re-run this rollback.',
      );
    }
  }
  // The CHECK goes first: dropping the column it constrains while it exists is
  // refused by MySQL.
  await knex.raw(`ALTER TABLE promotions DROP CHECK ${TARGET_CHECK}`).catch((err) => {
    if (err.errno !== ER_CHECK_CONSTRAINT_NOT_FOUND) throw err;
  });
  if (await knex.schema.hasColumn('promotions', 'applies_to')) {
    await knex.schema.alterTable('promotions', (t) => { t.dropColumn('applies_to'); });
  }
};
