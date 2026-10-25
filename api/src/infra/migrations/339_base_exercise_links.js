/**
 * #1849 stage E3 (Exercises) — `base_exercise_id` on the five places that reference an
 * exercise by id, Foods' migration 326 one catalogue over.
 *
 * ── Why a second column ─────────────────────────────────────────────────────
 * `exercise_id` has an FK to `exercises`. It can name a gym's own exercise (that table)
 * or a System exercise (now `base_exercises`), and one FK cannot target two tables. The
 * agreed shape: this column carries the FK to the Base table, the old column stays for
 * gym-owned exercises, and the cut-over stage (E5) makes it exactly one of the two.
 *
 *   workout_template_exercises     exercise_id           RESTRICT
 *   workout_exercises              exercise_id           RESTRICT
 *   exercise_logs                  exercise_id           RESTRICT
 *   member_standalone_exercises    exercise_id           RESTRICT
 *   exercises                      cloned_from_id        SET NULL  (a gym copy's provenance)
 *
 * On `exercises` the column records the Base exercise a gym copy was cloned from
 * (`cloned_from_id` keeps pointing at the System row until the cut-over), the way
 * `personal_goals.base_personal_goal_id` does.
 *
 * ── Strictly additive ───────────────────────────────────────────────────────
 * Nothing is dropped or changed: the old columns, their NOT NULL and their FKs stay, and
 * no reader or writer uses the new column yet (stage E4), so a row written before E4
 * ships has it NULL — migration 340 re-runs this idempotent backfill. Base ids equal the
 * legacy System ids (E1), so the backfill sets `base_exercise_id = exercise_id`
 * (`cloned_from_id`) for rows pointing at a `gym_id IS NULL` exercise; it refuses to run
 * if such an exercise has no Base twin (`npm run exercises:audit-base-links` reports it
 * read-only). The unique key of `member_standalone_exercises` stays on the old column
 * until the cut-over.
 */
const TABLES = [
  { table: 'workout_template_exercises', from: 'exercise_id', fk: 'wte_base_ex_fk', idx: 'wte_base_ex_idx', onDelete: 'RESTRICT' },
  { table: 'workout_exercises', from: 'exercise_id', fk: 'we_base_ex_fk', idx: 'we_base_ex_idx', onDelete: 'RESTRICT' },
  { table: 'exercise_logs', from: 'exercise_id', fk: 'el_base_ex_fk', idx: 'el_base_ex_idx', onDelete: 'RESTRICT' },
  { table: 'member_standalone_exercises', from: 'exercise_id', fk: 'mse_base_ex_fk', idx: 'mse_base_ex_idx', onDelete: 'RESTRICT' },
  { table: 'exercises', from: 'cloned_from_id', fk: 'ex_base_clone_fk', idx: 'ex_base_clone_idx', onDelete: 'SET NULL' },
];

exports.up = async (knex) => {
  const [[missing]] = await knex.raw(`
    SELECT COUNT(*) AS n FROM exercises e
     WHERE e.gym_id IS NULL AND NOT EXISTS (SELECT 1 FROM base_exercises b WHERE b.id = e.id)
  `);
  if (Number(missing.n) > 0) {
    throw new Error(`#1849 E3: ${missing.n} System exercise(s) in exercises have no base_exercises row; run the copy (migration 336) first`);
  }

  for (const { table, from, fk, idx, onDelete } of TABLES) {
    if (!(await knex.schema.hasColumn(table, 'base_exercise_id'))) {
      await knex.raw(`
        ALTER TABLE ${table}
          ADD COLUMN base_exercise_id INT UNSIGNED NULL,
          ADD KEY ${idx} (base_exercise_id),
          ADD CONSTRAINT ${fk} FOREIGN KEY (base_exercise_id)
            REFERENCES base_exercises(id) ON DELETE ${onDelete}
      `);
    }
    await knex.raw(`
      UPDATE ${table} t
        JOIN exercises x ON x.id = t.${from} AND x.gym_id IS NULL
         SET t.base_exercise_id = x.id
       WHERE t.base_exercise_id IS NULL
    `);
  }
};

exports.down = async () => {};
