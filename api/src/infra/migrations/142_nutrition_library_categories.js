/**
 * #501: Nutrition Library — multiple food categories per item, plus fat/fiber
 * nutritional qualities.
 *
 * `category` was a single VARCHAR column with an app-level CHECK constraint.
 * A food (e.g. peas) can belong to more than one category (main dish + side),
 * so it's converted to the same global-catalogue + M2M-junction shape already
 * used for nutritional_qualities (#293):
 *
 * 1. nutrition_library_categories — global catalogue (no gym_id), identified by slug.
 * 2. nutrition_library_item_categories — M2M junction (item ↔ category).
 * 3. Dedup any pre-existing (gym, name) rows that only differed by category —
 *    the old schema explicitly allowed this (e.g. "Peas" as both a separate
 *    main_dish row and a separate side row), which is exactly the workaround
 *    this ticket replaces, so real data may have it. Merge duplicates onto one
 *    canonical row (repointing every FK that references the merged-away ids)
 *    before the new (gym, name)-only unique index is created.
 * 4. Backfill every item's existing scalar `category` into the junction table,
 *    then drop the old column, its CHECK constraint and its indexes.
 * 5. Seed nutritional_qualities with `fat` and `fiber`.
 */
exports.up = async (knex) => {
  if (!await knex.schema.hasTable('nutrition_library_categories')) {
    await knex.raw(`
      CREATE TABLE nutrition_library_categories (
        id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
        slug       VARCHAR(50)  NOT NULL,
        created_at DATETIME     NOT NULL DEFAULT (UTC_TIMESTAMP()),
        PRIMARY KEY (id),
        UNIQUE KEY nlc_slug_unique (slug)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
    await knex('nutrition_library_categories').insert([
      { slug: 'main_dish' },
      { slug: 'side' },
      { slug: 'sauce' },
      { slug: 'drink' },
      { slug: 'dessert' },
      { slug: 'other' },
    ]);
  }

  if (!await knex.schema.hasTable('nutrition_library_item_categories')) {
    await knex.raw(`
      CREATE TABLE nutrition_library_item_categories (
        item_id     INT UNSIGNED NOT NULL,
        category_id INT UNSIGNED NOT NULL,
        created_at  DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP()),
        PRIMARY KEY (item_id, category_id),
        CONSTRAINT nlic_item_fk     FOREIGN KEY (item_id)     REFERENCES nutrition_library_items(id)      ON DELETE CASCADE,
        CONSTRAINT nlic_category_fk FOREIGN KEY (category_id) REFERENCES nutrition_library_categories(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
  }

  // Only runs once: `category` is dropped at the end of this block, so a
  // re-run of this migration (hasColumn === false) skips straight through.
  if (await knex.schema.hasColumn('nutrition_library_items', 'category')) {
    // ── Dedup (gym, name) groups that only differed by category ────────────
    // Maps every id that will be merged away → the canonical id (MIN(id) in
    // its group) it's merged into. Empty when there are no duplicates.
    await knex.raw('DROP TEMPORARY TABLE IF EXISTS nli_dedup_map');
    // Prefer an active row as canonical over a soft-deleted one (falling back
    // to lowest id as a tiebreaker) — otherwise, if the lower-id row in a
    // duplicate group happened to be `status='deleted'`, the surviving *active*
    // row would be the one hard-deleted below, silently vanishing from every
    // `WHERE status != 'deleted'` list despite still being referenced by
    // meal plans/restrictions repointed onto it.
    await knex.raw(`
      CREATE TEMPORARY TABLE nli_dedup_map AS
      SELECT old_id, canonical_id FROM (
        SELECT id AS old_id,
               FIRST_VALUE(id) OVER (
                 PARTITION BY COALESCE(gym_id, ''), name
                 ORDER BY (status = 'active') DESC, id ASC
               ) AS canonical_id,
               COUNT(*) OVER (PARTITION BY COALESCE(gym_id, ''), name) AS group_size
        FROM nutrition_library_items
      ) ranked
      WHERE group_size > 1 AND old_id <> canonical_id
    `);

    // Backfill categories using the canonical id for any item being merged
    // away, so a duplicate's category is preserved on the surviving row
    // instead of lost. Falls back to 'other' if `category` doesn't match any
    // seeded slug (stale/typo'd value) instead of silently dropping the item.
    await knex.raw(`
      INSERT IGNORE INTO nutrition_library_item_categories (item_id, category_id)
      SELECT COALESCE(map.canonical_id, nli.id) AS item_id,
             COALESCE(nlc.id, other_cat.id) AS category_id
      FROM nutrition_library_items nli
      LEFT JOIN nli_dedup_map map ON map.old_id = nli.id
      LEFT JOIN nutrition_library_categories nlc ON nlc.slug = nli.category
      CROSS JOIN (SELECT id FROM nutrition_library_categories WHERE slug = 'other') other_cat
    `);

    // Every surviving item must have ended up with at least one category —
    // abort loudly rather than silently dropping the column on a partial backfill.
    const [[{ missing }]] = await knex.raw(`
      SELECT COUNT(*) AS missing
      FROM nutrition_library_items nli
      WHERE nli.id NOT IN (SELECT old_id FROM nli_dedup_map)
        AND NOT EXISTS (
          SELECT 1 FROM nutrition_library_item_categories nlic WHERE nlic.item_id = nli.id
        )
    `);
    if (missing > 0) {
      throw new Error(`nutrition_library_categories backfill left ${missing} item(s) with no category`);
    }

    // Repoint every FK that references a to-be-merged-away id onto its
    // canonical id before deleting the duplicates (ON DELETE RESTRICT on the
    // template/member restriction & meal-item tables would otherwise block it).
    await knex.raw(`
      UPDATE nutrition_plan_template_restrictions r
      JOIN nli_dedup_map map ON map.old_id = r.nutrition_library_item_id
      SET r.nutrition_library_item_id = map.canonical_id
    `);
    await knex.raw(`
      UPDATE nutrition_plan_template_meal_items i
      JOIN nli_dedup_map map ON map.old_id = i.nutrition_library_item_id
      SET i.nutrition_library_item_id = map.canonical_id
    `);
    await knex.raw(`
      UPDATE member_nutrition_plan_meal_items i
      JOIN nli_dedup_map map ON map.old_id = i.nutrition_library_item_id
      SET i.nutrition_library_item_id = map.canonical_id
    `);
    await knex.raw(`
      UPDATE member_nutrition_plan_restrictions r
      JOIN nli_dedup_map map ON map.old_id = r.nutrition_library_item_id
      SET r.nutrition_library_item_id = map.canonical_id
    `);
    // Nutritional-quality links: merge onto the canonical id where possible;
    // any left pointing at an old_id (skipped because the canonical row
    // already has that quality) cascade-delete when the duplicate row itself
    // is deleted below — no data loss, since the canonical row keeps the tag.
    await knex.raw(`
      UPDATE IGNORE nutrition_library_item_qualities q
      JOIN nli_dedup_map map ON map.old_id = q.item_id
      SET q.item_id = map.canonical_id
    `);

    await knex.raw(`
      DELETE FROM nutrition_library_items WHERE id IN (SELECT old_id FROM nli_dedup_map)
    `);
    await knex.raw('DROP TEMPORARY TABLE IF EXISTS nli_dedup_map');

    const [checkExists] = await knex.raw(
      "SELECT CONSTRAINT_NAME FROM information_schema.CHECK_CONSTRAINTS " +
      "WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_NAME = 'nli_category_check'",
    );
    if (checkExists.length) {
      await knex.raw('ALTER TABLE nutrition_library_items DROP CHECK nli_category_check');
    }

    const [oldIdx] = await knex.raw(
      "SELECT INDEX_NAME FROM information_schema.STATISTICS " +
      "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'nutrition_library_items' " +
      "AND INDEX_NAME = 'nli_gym_name_cat'",
    );
    if (oldIdx.length) {
      await knex.raw('DROP INDEX nli_gym_name_cat ON nutrition_library_items');
    }

    const [oldCatIdx] = await knex.raw(
      "SELECT INDEX_NAME FROM information_schema.STATISTICS " +
      "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'nutrition_library_items' " +
      "AND INDEX_NAME = 'nli_category_index'",
    );
    if (oldCatIdx.length) {
      await knex.raw('DROP INDEX nli_category_index ON nutrition_library_items');
    }

    // Uniqueness is now scoped to (gym, name) only — category no longer
    // distinguishes rows now that an item can carry several. Safe now that
    // same-(gym, name) duplicates have been merged above.
    const [newIdx] = await knex.raw(
      "SELECT INDEX_NAME FROM information_schema.STATISTICS " +
      "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'nutrition_library_items' " +
      "AND INDEX_NAME = 'nli_gym_name_unique'",
    );
    if (!newIdx.length) {
      await knex.raw(
        "CREATE UNIQUE INDEX nli_gym_name_unique ON nutrition_library_items ((COALESCE(gym_id, '')), name)",
      );
    }

    await knex.raw('ALTER TABLE nutrition_library_items DROP COLUMN category');
  }

  await knex.raw("INSERT IGNORE INTO nutritional_qualities (slug) VALUES ('fat'), ('fiber')");
};

exports.down = async (knex) => {
  if (!await knex.schema.hasColumn('nutrition_library_items', 'category')) {
    await knex.raw('ALTER TABLE nutrition_library_items ADD COLUMN category VARCHAR(30) NULL AFTER name');

    // Best-effort backfill: an item that gained multiple categories can only
    // carry one scalar value again, so the lowest category_id (first assigned)
    // wins. Items left with no category (shouldn't happen — category_ids is
    // required going forward) fall back to 'other'. Note this cannot restore
    // rows merged by up()'s dedup step (that data loss is inherent to
    // reversing a many-to-many back into one-to-one and is not re-created here).
    await knex.raw(`
      UPDATE nutrition_library_items nli
      LEFT JOIN (
        SELECT nlic.item_id, MIN(nlic.category_id) AS category_id
        FROM nutrition_library_item_categories nlic
        GROUP BY nlic.item_id
      ) first_cat ON first_cat.item_id = nli.id
      LEFT JOIN nutrition_library_categories nlc ON nlc.id = first_cat.category_id
      SET nli.category = COALESCE(nlc.slug, 'other')
    `);

    await knex.raw('ALTER TABLE nutrition_library_items MODIFY COLUMN category VARCHAR(30) NOT NULL');

    await knex.raw('DROP INDEX nli_gym_name_unique ON nutrition_library_items').catch(() => {});
    await knex.raw(
      "CREATE UNIQUE INDEX nli_gym_name_cat ON nutrition_library_items ((COALESCE(gym_id, '')), name, category)",
    ).catch(() => {});
    await knex.raw("CREATE INDEX nli_category_index ON nutrition_library_items (category)").catch(() => {});
    await knex.raw(
      "ALTER TABLE nutrition_library_items ADD CONSTRAINT nli_category_check " +
      "CHECK (category IN ('main_dish','side','sauce','drink','dessert','other'))",
    ).catch(() => {});
  }

  await knex.schema.dropTableIfExists('nutrition_library_item_categories');
  await knex.schema.dropTableIfExists('nutrition_library_categories');

  await knex('nutritional_qualities').whereIn('slug', ['fat', 'fiber']).delete().catch(() => {});
};
