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
 * 3. Backfill every item's existing scalar `category` into the junction table,
 *    then drop the old column, its CHECK constraint and its indexes.
 * 4. Seed nutritional_qualities with `fat` and `fiber`.
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
    await knex.raw(`
      INSERT INTO nutrition_library_item_categories (item_id, category_id)
      SELECT nli.id, nlc.id
      FROM nutrition_library_items nli
      JOIN nutrition_library_categories nlc ON nlc.slug = nli.category
    `);

    await knex.raw('ALTER TABLE nutrition_library_items DROP CHECK nli_category_check').catch(() => {});

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
    // distinguishes rows now that an item can carry several.
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
    // required going forward) fall back to 'other'.
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
