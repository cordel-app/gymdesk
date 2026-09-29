/**
 * #900: a Promotion that reached its End Date is `expired`, which is not the
 * same state as `inactive`.
 *
 * `inactive` means somebody switched the Promotion off; `expired` means its
 * validity period ran out on its own. Until now both read as `inactive` — or,
 * more often, as `active` for ever, because nothing ever moved a Promotion off
 * `active` when its `ends_at` passed. The list therefore showed long-dead
 * Promotions as Active, while every apply path refused them ("outside its
 * active window", `validatePromotionSelection` in `membership-promotions.ts`),
 * so the status column and the behaviour disagreed.
 *
 * This migration only widens `chk_promotions_lifecycle_status` to admit the new
 * value. The sweep that writes it is `POST /promotion-lifecycle/run`
 * (`api/src/api/promotion-lifecycle.ts`) and the rule it applies is
 * `api/src/domain/promotionLifecycle.ts` — a new Promotion lifecycle status
 * goes in those two places, the list and the CHECK beside it.
 *
 * **Nothing is backfilled here.** A migration that expired every past-dated
 * Promotion would be a data decision taken silently at deploy time, in a
 * statement that cannot be reviewed per gym; the sweep does it on its first run
 * instead, idempotently and with a counter in the workflow log. `up` is
 * therefore a pure widening, which never fails on existing rows.
 *
 * `down` is not: narrowing the CHECK back would be rejected by MySQL while any
 * `expired` row exists, and DDL is not transactional, so the `DROP` would
 * already have run and the table would be left with no status CHECK at all
 * (migration 198's note). So `down` clears those rows first — to **`active`**,
 * which is where they were before this ticket (nothing moved a Promotion off
 * `active` when its `ends_at` passed) and the only value that makes the round
 * trip self-healing: the sweep's expirable set is `active` alone, so parking
 * them on `inactive` would strand every one of them there for ever, in the state
 * that means *a human switched this off*. Nothing becomes applicable either way
 * — every apply path refuses a Promotion whose `ends_at` has passed whatever its
 * status (`validatePromotionSelection`, `membership-promotions.ts`). Migration
 * 198's other option, refusing rather than converting, is not available here:
 * `up` writes no row, so these rows exist only because the sweep made them.
 *
 * Cost: `ADD CONSTRAINT … CHECK` is `ALGORITHM=COPY` (MySQL refuses INPLACE),
 * so this rebuilds `promotions` once under a metadata lock. `promotions` is a
 * small per-gym catalogue table — nothing like the `user_memberships` rebuild
 * CLAUDE.md warns about — and migration 093 already paid the same cost on it
 * when it added `deleted` to this very constraint.
 */

/** MySQL: ER_CHECK_CONSTRAINT_NOT_FOUND — the only error a DROP CHECK may swallow. */
const ER_CHECK_CONSTRAINT_NOT_FOUND = 3940;

const STATUS_CHECK = 'chk_promotions_lifecycle_status';
/** Migration 093's set. */
const NARROW = ['active', 'inactive', 'deleted'];
const WIDE = ['active', 'inactive', 'expired', 'deleted'];

/**
 * The lifecycle CHECK's clause with MySQL's escaping removed, or null when the
 * table has none. MySQL stores each literal with a charset prefix and escaped
 * quotes (`_utf8mb4\'expired\'`), so the backslashes come off before matching.
 */
const lifecycleCheckClause = async (knex) => {
  const rows = await knex.raw(
    `SELECT cc.CHECK_CLAUSE
       FROM information_schema.CHECK_CONSTRAINTS cc
       JOIN information_schema.TABLE_CONSTRAINTS tc
         ON tc.CONSTRAINT_SCHEMA = cc.CONSTRAINT_SCHEMA
        AND tc.CONSTRAINT_NAME = cc.CONSTRAINT_NAME
      WHERE tc.TABLE_SCHEMA = DATABASE()
        AND tc.TABLE_NAME = 'promotions'
        AND cc.CONSTRAINT_NAME = ?`,
    [STATUS_CHECK],
  );
  const clause = rows[0][0]?.CHECK_CLAUSE;
  return clause == null ? null : clause.replace(/\\/g, '');
};

const setLifecycleCheck = async (knex, values) => {
  await knex.raw(`ALTER TABLE promotions DROP CHECK ${STATUS_CHECK}`).catch((err) => {
    if (err.errno !== ER_CHECK_CONSTRAINT_NOT_FOUND) throw err;
  });
  await knex.raw(
    `ALTER TABLE promotions ADD CONSTRAINT ${STATUS_CHECK} ` +
    `CHECK (lifecycle_status IN (${values.map((v) => `'${v}'`).join(',')}))`,
  );
};

exports.up = async (knex) => {
  const clause = await lifecycleCheckClause(knex);
  // Every value, not just the new one: a CHECK that somehow lost one of the
  // others is corrected rather than accepted. A widening cannot fail on data.
  if (clause != null && WIDE.every((v) => clause.includes(`'${v}'`))) return;
  await setLifecycleCheck(knex, WIDE);
};

exports.down = async (knex) => {
  const clause = await lifecycleCheckClause(knex);
  if (clause != null && !clause.includes("'expired'")) return;
  // Before narrowing: no row may hold the value the CHECK is about to forbid.
  // `active`, never `inactive` — see the note above. The sweep re-expires these
  // on its next run after a roll-forward; `inactive` is a deliberate
  // administrative state it must never revisit (`EXPIRABLE_STATUSES`,
  // `api/src/domain/promotionLifecycle.ts`), so it would be a one-way door.
  await knex('promotions').where({ lifecycle_status: 'expired' }).update({ lifecycle_status: 'active' });
  await setLifecycleCheck(knex, NARROW);
};
