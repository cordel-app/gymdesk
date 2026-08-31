/**
 * #293: Nutritional Qualities for Nutrition Library Foods.
 *
 * 1. nutritional_qualities — global catalogue (no gym_id), identified by slug.
 * 2. nutrition_library_item_qualities — M2M junction (item ↔ quality).
 * 3. Seed: protein, carbohydrate.
 */
exports.up = async (knex) => {
  if (!await knex.schema.hasTable('nutritional_qualities')) {
    await knex.raw(`
      CREATE TABLE nutritional_qualities (
        id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
        slug       VARCHAR(50)  NOT NULL,
        created_at DATETIME     NOT NULL DEFAULT (UTC_TIMESTAMP()),
        PRIMARY KEY (id),
        UNIQUE KEY nq_slug_unique (slug)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
    await knex('nutritional_qualities').insert([
      { slug: 'protein' },
      { slug: 'carbohydrate' },
    ]);
  }

  if (!await knex.schema.hasTable('nutrition_library_item_qualities')) {
    await knex.raw(`
      CREATE TABLE nutrition_library_item_qualities (
        item_id    INT UNSIGNED NOT NULL,
        quality_id INT UNSIGNED NOT NULL,
        created_at DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP()),
        PRIMARY KEY (item_id, quality_id),
        CONSTRAINT nliq_item_fk    FOREIGN KEY (item_id)    REFERENCES nutrition_library_items(id) ON DELETE CASCADE,
        CONSTRAINT nliq_quality_fk FOREIGN KEY (quality_id) REFERENCES nutritional_qualities(id)   ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
  }
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('nutrition_library_item_qualities');
  await knex.schema.dropTableIfExists('nutritional_qualities');
};
