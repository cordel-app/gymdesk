/**
 * #1849 stage F2b (Foods) — the read models of the Foods a gym can see, the
 * Personal / Nutrition Goals' catalogue views (315, 322) one catalogue over, one
 * view per table the readers use so a reader changes a table name and nothing else:
 *
 *   nutrition_library_item_catalogue                       (the items)
 *   nutrition_library_item_category_catalogue              (item <-> category)
 *   nutrition_library_item_quality_catalogue               (item <-> quality)
 *   nutrition_library_item_translation_catalogue           (item name per locale)
 *   nutrition_library_item_description_translation_catalogue
 *
 * A System food (`gym_id` NULL, `status` derived from `deleted_at`) comes from the
 * `base_nutrition_library_*` tables, which Cordel's router (stage F2) writes; a gym's
 * own food and its rows come from the legacy tables. Base ids are drawn from the
 * legacy sequence, so the two never collide. Read-only: every writer still targets a
 * real table, and the five plan foreign keys still reference the legacy rows (F3).
 */
exports.up = async (knex) => {
  await knex.raw(`
    CREATE OR REPLACE VIEW nutrition_library_item_catalogue AS
    SELECT id, NULL AS gym_id, name, created_at,
           IF(deleted_at IS NULL, 'active', 'deleted') AS status,
           modified_at, image_url, description, created_by, modified_by, deleted_by, deleted_at
      FROM base_nutrition_library_items
    UNION ALL
    SELECT id, gym_id, name, created_at, status,
           modified_at, image_url, description, created_by, modified_by, deleted_by, deleted_at
      FROM nutrition_library_items
     WHERE gym_id IS NOT NULL
  `);
  const junction = (view, base, legacy, cols) => knex.raw(`
    CREATE OR REPLACE VIEW ${view} AS
    SELECT ${cols} FROM ${base}
    UNION ALL
    SELECT ${cols.split(', ').map((c) => `t.${c}`).join(', ')} FROM ${legacy} t
      JOIN nutrition_library_items i ON i.id = t.item_id AND i.gym_id IS NOT NULL
  `);
  await junction('nutrition_library_item_category_catalogue',
    'base_nutrition_library_item_categories', 'nutrition_library_item_categories', 'item_id, category_id, created_at');
  await junction('nutrition_library_item_quality_catalogue',
    'base_nutrition_library_item_qualities', 'nutrition_library_item_qualities', 'item_id, quality_id, created_at');
  await junction('nutrition_library_item_translation_catalogue',
    'base_nutrition_library_item_translations', 'nutrition_library_item_translations', 'item_id, locale, name, created_at, modified_at');
  await junction('nutrition_library_item_description_translation_catalogue',
    'base_nutrition_library_item_description_translations', 'nutrition_library_item_description_translations', 'item_id, locale, description, created_at, modified_at');
};

exports.down = async (knex) => {
  for (const v of [
    'nutrition_library_item_description_translation_catalogue', 'nutrition_library_item_translation_catalogue',
    'nutrition_library_item_quality_catalogue', 'nutrition_library_item_category_catalogue', 'nutrition_library_item_catalogue',
  ]) await knex.raw(`DROP VIEW IF EXISTS ${v}`);
};
