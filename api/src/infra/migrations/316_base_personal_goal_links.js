/**
 * #1849 stage 2d — `base_personal_goal_id` on `member_personal_goals` and
 * `gym_personal_goals`: the foreign key a System goal will be referenced through.
 *
 * ── Why a second column ─────────────────────────────────────────────────────
 * `personal_goal_id` has an `ON DELETE CASCADE` FK to `personal_goals`. It can name
 * a gym's own goal (that table) or a System goal (now `base_personal_goals`), and
 * one FK cannot target two tables. The owner approved the two-column shape: this
 * column carries the FK to the Base table, `personal_goal_id` stays for gym-owned
 * goals, and stage 2f makes it exactly one of the two.
 *
 * ── Strictly additive ───────────────────────────────────────────────────────
 * Nothing is dropped or changed: `personal_goal_id` keeps its NOT NULL, its FK, its
 * unique keys. No reader or writer uses the new column yet (stage 2e), so a row
 * written between this migration and 2e has it NULL — 2e re-runs the idempotent
 * backfill. The FK is `ON DELETE RESTRICT` (a Base goal is soft-deleted; a hard
 * delete of a referenced one must fail loudly, never cascade into assignments).
 *
 * ── Backfill and its guard ──────────────────────────────────────────────────
 * Base ids equal the legacy System ids (2a), so the backfill sets
 * `base_personal_goal_id = personal_goal_id` for rows pointing at a
 * `gym_id IS NULL` goal. It first refuses to run if one of those goals has no Base
 * row, since the FK would then fail half-way; migration 314 is the catch-up that
 * prevents it, and `npm run goals:audit-base-links` reports it read-only.
 */
const TABLES = [
  { table: 'member_personal_goals', fk: 'mpgoal_base_goal_fk', index: 'mpgoal_base_goal_index' },
  { table: 'gym_personal_goals', fk: 'gpg_base_goal_fk', index: 'gpg_base_goal_idx' },
];

exports.up = async (knex) => {
  const [[missing]] = await knex.raw(`
    SELECT COUNT(*) AS n FROM personal_goals p
     WHERE p.gym_id IS NULL AND NOT EXISTS (SELECT 1 FROM base_personal_goals b WHERE b.id = p.id)
  `);
  if (Number(missing.n) > 0) {
    throw new Error(`#1849 2d: ${missing.n} System goal(s) in personal_goals have no base_personal_goals row; run the catch-up copy (migration 314) first`);
  }

  for (const { table, fk, index } of TABLES) {
    if (!(await knex.schema.hasColumn(table, 'base_personal_goal_id'))) {
      await knex.raw(`
        ALTER TABLE ${table}
          ADD COLUMN base_personal_goal_id INT UNSIGNED NULL,
          ADD KEY ${index} (base_personal_goal_id),
          ADD CONSTRAINT ${fk} FOREIGN KEY (base_personal_goal_id)
            REFERENCES base_personal_goals(id) ON DELETE RESTRICT
      `);
    }
    await knex.raw(`
      UPDATE ${table} t
        JOIN personal_goals p ON p.id = t.personal_goal_id AND p.gym_id IS NULL
         SET t.base_personal_goal_id = p.id
       WHERE t.base_personal_goal_id IS NULL
    `);
  }
};

exports.down = async () => {};
