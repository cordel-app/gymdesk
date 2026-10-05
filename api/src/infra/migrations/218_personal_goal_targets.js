/**
 * #1034 — a **Personal Goal is measurable**: the catalogue row carries a numeric
 * target and the unit that says what the number counts, and an assignment
 * carries the **name** it was agreed under.
 *
 * ── Why the pair goes on the catalogue as well as the assignment ────────────
 *
 * `member_personal_goals` has carried `target_value` + `target_unit` since
 * migration 212: that is the target agreed with *one* member ("John: lose 5 kg").
 * What #1034 §1 adds is the reusable one on the catalogue row itself ("Lose
 * weight: 3 kg"), which is what the `Assign goal to member` modal pre-fills
 * from (§5) and what §8 then lets staff override per member. The two are the
 * same kind of value — same column types, same CHECKs, one normalizer
 * (`api/src/domain/goalTarget.ts`) — because §1 forbids a second, incompatible
 * unit system, and a target the catalogue accepted that the assignment refused
 * would be exactly that.
 *
 * The unit stays **free text** (VARCHAR(20)) rather than becoming an enum, for
 * the same reason: this codebase has no measurement-unit vocabulary to reuse
 * (the only `*_UNITS` lists are billing periods), so declaring one here would be
 * the second system, and a gym measuring in `lb` or `laps` is not an error.
 *
 * ── `nutrition_goals` is deliberately untouched ─────────────────────────────
 *
 * The two catalogues are two tables precisely so they can diverge (migration
 * 206's header), and a Nutrition Goal's target values ("2,000 kcal") are still a
 * later ticket's — CLAUDE.md says so in as many words. So only `personal_goals`
 * grows the pair, and `MEASURABLE_GOAL_KINDS` in
 * `api/src/domain/goalLibrary.ts` is the one place that says which kinds have it.
 *
 * ── The seeded System goals get a target where one *means* something ────────
 *
 * §2 asks for "reasonable values based on the meaning of each goal" and forbids
 * "the same generic target" on every one of them. Three of migration 206's seven
 * are quantities of body mass and one is the absence of a change, so they get a
 * number in kilograms; **Performance, Recovery and Energy get none**, because
 * neither has a magnitude or a unit that follows from what it represents, and a
 * number invented for them would be the generic target §2 rules out wearing a
 * different value. §13 concedes exactly this by requiring a unit only "for
 * measurable goals": the columns are NULLable, `—` is a legitimate target, and a
 * gym may set one on its own copy or per assignment.
 *
 * The seed only ever fills a row that has **no** target yet, so a value Cordel
 * has since changed is never overwritten and a re-run is a no-op.
 *
 * ── `member_personal_goals.goal_name`: the snapshot §7/§12 asks for ─────────
 *
 * §7 is explicit that renaming a Gym Goal must not change an existing member's
 * assignment, and §12 names `nameSnapshot` as the field that makes it so. Until
 * now the assignment read `personal_goals.name` live, so a rename moved every
 * assignment of that goal. The column is written by the one `POST` that creates
 * an assignment and read in place of the join.
 *
 * It is **NULLable with no backfill**, which is #635 §16's shape rather than an
 * oversight: a row assigned before this migration has no snapshot to recover —
 * the catalogue's *current* name is not evidence of what it was called then — so
 * the live name stays its one fallback (`COALESCE(mpg.goal_name, pg.name)`), and
 * writing today's name into it would claim a fact the database never recorded.
 *
 * A seeded System goal is unaffected either way: its label is resolved from its
 * immutable `slug` through a locale key, and the snapshot is only ever the
 * fallback behind it.
 *
 * `down()` is therefore **lossy in a way `up()` cannot repair**: dropping the
 * column destroys every snapshot ever taken, and re-running `up` re-adds an
 * empty one, which silently re-points every existing assignment at the live
 * catalogue name — the very behaviour §7 exists to stop. There is nothing else a
 * `down` of a snapshot column could do; it is recorded here so the next reader
 * does not mistake this one for reversible.
 *
 * ── Two costs, both deliberate ──────────────────────────────────────────────
 *
 * The two `ADD CONSTRAINT … CHECK` statements rebuild `personal_goals` under
 * `ALGORITHM=COPY` — which is exactly why CLAUDE.md declines a CHECK on
 * `user_memberships` and `products`. It is the opposite answer here because this
 * is a catalogue of seven System rows plus a handful per gym, and the two
 * guarded `ALTER`s are kept separate rather than merged so each stays
 * idempotent on its own. The assignment table, by contrast, grows per member per
 * goal, so its column is appended with **no `AFTER`**: a mid-table `ADD COLUMN`
 * is non-INSTANT before MySQL 8.0.29, and the position buys nothing.
 *
 * The seed `UPDATE` matching **no** row is a success, not a failure: a slug whose
 * row migration 206's own seed skipped, or that Cordel has since deleted, has
 * nothing to fill, and failing a migration because an administrator deleted a
 * System goal would be worse than the silence. A *soft-deleted* System row is
 * filled on purpose for the same reason — it is invisible until somebody
 * restores it, and a restored goal with a sensible target is the better outcome
 * than one with none.
 *
 * Every statement is guarded on its own: MySQL commits DDL implicitly, so a
 * crash between two of them must not make a re-run skip one (migrations
 * 134/140/155/183/205/206/212).
 */

const GOAL_TABLE = 'personal_goals';
/** Mirrors migration 206's `TABLES`: the prefix every constraint is named with. */
const GOAL_PREFIX = 'pgoal';

const ASSIGNMENT_TABLE = 'member_personal_goals';

/**
 * The §2 defaults, keyed by migration 206's slugs. A slug absent from this map
 * is a System goal that deliberately has no target (see the header).
 *
 * Re-runnable for crash recovery *within this migration*, not a place to edit
 * the catalogue: knex never re-runs a migration it has recorded, so changing a
 * default later is a new migration.
 */
const SEED_TARGETS = {
  // Lose three kilograms — the ticket's own worked example (§1, §2).
  weight_loss: { value: 3, unit: 'kg' },
  // The mirror of it, and the same order of magnitude for the same reason.
  weight_gain: { value: 3, unit: 'kg' },
  // Lean mass accrues more slowly than body weight moves, so a smaller figure.
  muscle_gain: { value: 2, unit: 'kg' },
  // Maintenance *is* a measurable goal: the target is a change of zero, which is
  // what the goal means, rather than a blank that reads as "not configured".
  maintenance: { value: 0, unit: 'kg' },
};

/**
 * A CHECK constraint's name is **schema-global** in MySQL 8, not table-scoped
 * (which is why migration 206 chose the `pgoal`/`ngoal` prefixes at all), so the
 * guard is scoped the same way. A table-scoped guard would answer `false` for a
 * name already taken one table over, and the `ADD CONSTRAINT` would then die
 * with ER_DUP_CONSTRAINT_NAME leaving the migration half-applied — the partial
 * state these per-statement guards exist to prevent. Index names *are*
 * table-scoped, which is why migration 206's `hasIndex()` names its table.
 */
async function hasCheck(knex, name) {
  const [rows] = await knex.raw(
    `SELECT COUNT(*) AS cnt FROM information_schema.TABLE_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_NAME = ?`,
    [name],
  );
  return Number(rows[0].cnt) > 0;
}

exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn(GOAL_TABLE, 'target_value'))) {
    await knex.raw(
      `ALTER TABLE ${GOAL_TABLE} ADD COLUMN target_value DECIMAL(10,2) NULL AFTER description`,
    );
  }
  if (!(await knex.schema.hasColumn(GOAL_TABLE, 'target_unit'))) {
    await knex.raw(
      `ALTER TABLE ${GOAL_TABLE} ADD COLUMN target_unit VARCHAR(20) NULL AFTER target_value`,
    );
  }

  // The same two CHECKs `member_personal_goals` already carries, word for word,
  // so the catalogue and the assignment cannot disagree about what a target is.
  // A unit with no value is refused; a value with no unit is incomplete rather
  // than contradictory and stays allowed — do not "complete" either of them.
  if (!(await hasCheck(knex, `chk_${GOAL_PREFIX}_target_value`))) {
    await knex.raw(
      `ALTER TABLE ${GOAL_TABLE} ADD CONSTRAINT chk_${GOAL_PREFIX}_target_value
       CHECK (target_value IS NULL OR target_value >= 0)`,
    );
  }
  if (!(await hasCheck(knex, `chk_${GOAL_PREFIX}_target_unit`))) {
    await knex.raw(
      `ALTER TABLE ${GOAL_TABLE} ADD CONSTRAINT chk_${GOAL_PREFIX}_target_unit
       CHECK (target_unit IS NULL OR target_value IS NOT NULL)`,
    );
  }

  // Only a System row (`gym_id IS NULL`) with no target yet, and only a slug
  // this migration has an opinion about.
  for (const [slug, target] of Object.entries(SEED_TARGETS)) {
    await knex.raw(
      `UPDATE ${GOAL_TABLE}
       SET target_value = ?, target_unit = ?
       WHERE slug = ? AND gym_id IS NULL AND target_value IS NULL AND target_unit IS NULL`,
      [target.value, target.unit, slug],
    );
  }

  if (!(await knex.schema.hasColumn(ASSIGNMENT_TABLE, 'goal_name'))) {
    await knex.raw(
      `ALTER TABLE ${ASSIGNMENT_TABLE} ADD COLUMN goal_name VARCHAR(255) NULL`,
    );
  }
};

exports.down = async (knex) => {
  // Dropping the CHECKs first: MySQL refuses to drop a column a CHECK names.
  for (const name of [`chk_${GOAL_PREFIX}_target_unit`, `chk_${GOAL_PREFIX}_target_value`]) {
    if (await hasCheck(knex, name)) {
      await knex.raw(`ALTER TABLE ${GOAL_TABLE} DROP CHECK ${name}`);
    }
  }
  for (const column of ['target_unit', 'target_value']) {
    if (await knex.schema.hasColumn(GOAL_TABLE, column)) {
      await knex.raw(`ALTER TABLE ${GOAL_TABLE} DROP COLUMN ${column}`);
    }
  }
  if (await knex.schema.hasColumn(ASSIGNMENT_TABLE, 'goal_name')) {
    await knex.raw(`ALTER TABLE ${ASSIGNMENT_TABLE} DROP COLUMN goal_name`);
  }
};

exports.SEED_TARGETS = SEED_TARGETS;
