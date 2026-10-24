/**
 * #1849 stage F3 (Foods) — `base_nutrition_library_item_id` on the five tables that
 * reference a Food by id, Personal Goals' migration 316 one catalogue over.
 *
 * ── Why a second column ─────────────────────────────────────────────────────
 * `nutrition_library_item_id` has an FK to `nutrition_library_items`. It can name a
 * gym's own food (that table) or a System food (now `base_nutrition_library_items`),
 * and one FK cannot target two tables. The agreed shape: this column carries the FK
 * to the Base table, `nutrition_library_item_id` stays for gym-owned foods, and the
 * cut-over stage makes it exactly one of the two (at most one on the two goal tables,
 * whose reference is optional).
 *
 *   member_nutrition_plan_meal_items      RESTRICT  (NOT NULL today)
 *   member_nutrition_plan_restrictions    RESTRICT  (NOT NULL today)
 *   nutrition_plan_template_meal_items    RESTRICT  (NOT NULL today)
 *   member_nutrition_plan_goals           SET NULL  (the goal's illustration)
 *   nutrition_plan_template_goals         SET NULL
 *
 * The new FK keeps the rule of the one it will replace. None of the five tables has a
 * unique key or a CHECK on the food column, so nothing else needs swapping.
 *
 * ── Strictly additive ───────────────────────────────────────────────────────
 * Nothing is dropped or changed: the old column, its NOT NULL and its FK stay, and no
 * reader or writer uses the new column yet (stage F4), so a row written before F4
 * ships has it NULL — F4 re-runs this idempotent backfill. Base ids equal the legacy
 * System ids (F1), so the backfill sets `base_nutrition_library_item_id =
 * nutrition_library_item_id` for rows pointing at a `gym_id IS NULL` food; it refuses
 * to run if such a food has no Base twin (migration 324 prevents that, and
 * `npm run foods:audit-base-links` reports it read-only).
 */
const TABLES = [
  { table: 'member_nutrition_plan_meal_items', fk: 'mnpmi_base_lib_fk', idx: 'mnpmi_base_lib_idx', onDelete: 'RESTRICT' },
  { table: 'member_nutrition_plan_restrictions', fk: 'mnpr_base_lib_fk', idx: 'mnpr_base_lib_idx', onDelete: 'RESTRICT' },
  { table: 'nutrition_plan_template_meal_items', fk: 'nptmi_base_lib_fk', idx: 'nptmi_base_lib_idx', onDelete: 'RESTRICT' },
  { table: 'member_nutrition_plan_goals', fk: 'mnpg_base_lib_fk', idx: 'mnpg_base_lib_idx', onDelete: 'SET NULL' },
  { table: 'nutrition_plan_template_goals', fk: 'nptg_base_lib_fk', idx: 'nptg_base_lib_idx', onDelete: 'SET NULL' },
];

exports.up = async (knex) => {
  const [[missing]] = await knex.raw(`
    SELECT COUNT(*) AS n FROM nutrition_library_items i
     WHERE i.gym_id IS NULL AND NOT EXISTS (SELECT 1 FROM base_nutrition_library_items b WHERE b.id = i.id)
  `);
  if (Number(missing.n) > 0) {
    throw new Error(`#1849 F3: ${missing.n} System food(s) in nutrition_library_items have no base_nutrition_library_items row; run the copy (migration 324) first`);
  }

  for (const { table, fk, idx, onDelete } of TABLES) {
    if (!(await knex.schema.hasColumn(table, 'base_nutrition_library_item_id'))) {
      await knex.raw(`
        ALTER TABLE ${table}
          ADD COLUMN base_nutrition_library_item_id INT UNSIGNED NULL,
          ADD KEY ${idx} (base_nutrition_library_item_id),
          ADD CONSTRAINT ${fk} FOREIGN KEY (base_nutrition_library_item_id)
            REFERENCES base_nutrition_library_items(id) ON DELETE ${onDelete}
      `);
    }
    await knex.raw(`
      UPDATE ${table} t
        JOIN nutrition_library_items i ON i.id = t.nutrition_library_item_id AND i.gym_id IS NULL
         SET t.base_nutrition_library_item_id = i.id
       WHERE t.base_nutrition_library_item_id IS NULL
    `);
  }
};

exports.down = async () => {};
