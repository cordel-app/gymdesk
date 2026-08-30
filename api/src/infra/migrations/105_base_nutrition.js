/**
 * #259: Base Nutrition Library + Base Plan Templates + Clone/Assign + Member Plans
 *
 * 1. nutrition_library_items: add gym_id (NULL=Cordel-owned), status, modified_at.
 *    Replace unique(name,category) with functional unique((COALESCE(gym_id,''), name, category).
 * 2. nutrition_plan_templates + 5 child tables: make gym_id nullable (base templates have gym_id IS NULL).
 *    Drop (gym_id, name) unique on templates; app-level uniqueness used instead.
 *    Add cloned_from_id.
 * 3. Create member_nutrition_plans + 5 child tables.
 */

/** Drop the gym_id→gyms FK for a table (by introspecting constraint name), make gym_id NULL, re-add FK. */
async function makeGymIdNullable(knex, tableName, newFkName) {
  const [rows] = await knex.raw(`
    SELECT rc.CONSTRAINT_NAME
    FROM information_schema.REFERENTIAL_CONSTRAINTS rc
    JOIN information_schema.KEY_COLUMN_USAGE kcu
      ON kcu.CONSTRAINT_NAME = rc.CONSTRAINT_NAME
     AND kcu.TABLE_SCHEMA   = rc.CONSTRAINT_SCHEMA
    WHERE rc.TABLE_NAME       = ?
      AND rc.REFERENCED_TABLE_NAME = 'gyms'
      AND rc.CONSTRAINT_SCHEMA = DATABASE()
      AND kcu.COLUMN_NAME = 'gym_id'
  `, [tableName]);

  for (const row of rows) {
    await knex.raw(`ALTER TABLE \`${tableName}\` DROP FOREIGN KEY \`${row.CONSTRAINT_NAME}\``).catch(() => {});
  }

  // Do NOT .catch() here — a failure leaves the column NOT NULL with no FK, which is broken state.
  await knex.raw(`ALTER TABLE \`${tableName}\` MODIFY COLUMN gym_id CHAR(36) NULL`);

  // .catch() is safe: "constraint already exists" is a legitimate no-op on re-run.
  await knex.raw(
    `ALTER TABLE \`${tableName}\` ADD CONSTRAINT \`${newFkName}\` FOREIGN KEY (gym_id) REFERENCES gyms(id) ON DELETE CASCADE`,
  ).catch(() => {});
}

exports.up = async (knex) => {
  // ── 1. nutrition_library_items: add gym_id, status, modified_at ────────────
  //
  // Each DDL step is individually guarded so a partial failure on a prior run
  // does not silently skip later steps.
  const hasGymId = await knex.schema.hasColumn('nutrition_library_items', 'gym_id');
  if (!hasGymId) {
    await knex.raw('ALTER TABLE nutrition_library_items ADD COLUMN gym_id CHAR(36) NULL AFTER id');
  }

  // Drop old global (name, category) unique — only if it still exists.
  const [oldIdx] = await knex.raw(
    "SELECT INDEX_NAME FROM information_schema.STATISTICS " +
    "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'nutrition_library_items' " +
    "AND INDEX_NAME = 'nli_name_category_unique'",
  );
  if (oldIdx.length) {
    await knex.raw('ALTER TABLE nutrition_library_items DROP INDEX nli_name_category_unique');
  }

  // Functional unique index: treats NULL gym_id as '' for uniqueness purposes.
  const [newIdx] = await knex.raw(
    "SELECT INDEX_NAME FROM information_schema.STATISTICS " +
    "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'nutrition_library_items' " +
    "AND INDEX_NAME = 'nli_gym_name_cat'",
  );
  if (!newIdx.length) {
    await knex.raw(
      "CREATE UNIQUE INDEX nli_gym_name_cat ON nutrition_library_items ((COALESCE(gym_id, '')), name, category)",
    );
  }

  const [existingFk] = await knex.raw(
    "SELECT CONSTRAINT_NAME FROM information_schema.REFERENTIAL_CONSTRAINTS " +
    "WHERE TABLE_NAME = 'nutrition_library_items' AND CONSTRAINT_NAME = 'nli_gym_fk' AND CONSTRAINT_SCHEMA = DATABASE()",
  );
  if (!existingFk.length) {
    await knex.raw(
      'ALTER TABLE nutrition_library_items ADD CONSTRAINT nli_gym_fk FOREIGN KEY (gym_id) REFERENCES gyms(id) ON DELETE CASCADE',
    );
  }

  const hasStatus = await knex.schema.hasColumn('nutrition_library_items', 'status');
  if (!hasStatus) {
    await knex.raw(
      "ALTER TABLE nutrition_library_items ADD COLUMN status VARCHAR(20) NOT NULL DEFAULT 'active'",
    );
    await knex.raw(
      "ALTER TABLE nutrition_library_items ADD CONSTRAINT chk_nli_status CHECK (status IN ('active','deleted'))",
    );
  }

  const hasModifiedAt = await knex.schema.hasColumn('nutrition_library_items', 'modified_at');
  if (!hasModifiedAt) {
    await knex.raw('ALTER TABLE nutrition_library_items ADD COLUMN modified_at DATETIME NULL');
  }

  // ── 2a. nutrition_plan_templates: make gym_id nullable ─────────────────────
  const nptHasGymId = await knex.schema.hasColumn('nutrition_plan_templates', 'gym_id');
  if (nptHasGymId) {
    await makeGymIdNullable(knex, 'nutrition_plan_templates', 'npt_gym_fk');
    // Drop the (gym_id, name) unique constraint — app enforces uniqueness within scope
    await knex.raw('ALTER TABLE nutrition_plan_templates DROP INDEX npt_gym_name_unique').catch(() => {});
  }

  // ── 2b. nutrition_plan_templates: add cloned_from_id ──────────────────────
  const hasClonedFrom = await knex.schema.hasColumn('nutrition_plan_templates', 'cloned_from_id');
  if (!hasClonedFrom) {
    await knex.raw(
      'ALTER TABLE nutrition_plan_templates ADD COLUMN cloned_from_id INT UNSIGNED NULL',
    );
    await knex.raw(
      'ALTER TABLE nutrition_plan_templates ADD CONSTRAINT npt_cloned_from_fk FOREIGN KEY (cloned_from_id) REFERENCES nutrition_plan_templates(id) ON DELETE SET NULL',
    );
  }

  // ── 2c. Child tables: make gym_id nullable ────────────────────────────────
  const childTables = [
    ['nutrition_plan_template_days',        'nptd_gym_fk'],
    ['nutrition_plan_template_meals',       'nptm_gym_fk_base'],
    ['nutrition_plan_template_meal_items',  'nptmi_gym_fk_base'],
    ['nutrition_plan_template_restrictions','nptr_gym_fk_base'],
    ['nutrition_plan_template_goals',       'nptg_gym_fk_base'],
  ];
  for (const [table, newFkName] of childTables) {
    const hasCol = await knex.schema.hasColumn(table, 'gym_id');
    if (hasCol) {
      await makeGymIdNullable(knex, table, newFkName);
    }
  }

  // ── 3. member_nutrition_plans (master + 5 child tables) ──────────────────
  if (!await knex.schema.hasTable('member_nutrition_plans')) {
    await knex.raw(`
      CREATE TABLE member_nutrition_plans (
        id                   INT UNSIGNED NOT NULL AUTO_INCREMENT,
        gym_id               CHAR(36) NOT NULL,
        member_id            INT UNSIGNED NOT NULL,
        template_id          INT UNSIGNED NULL,
        name                 VARCHAR(255) NOT NULL,
        description          TEXT NULL,
        start_date           DATE NULL,
        status               VARCHAR(20) NOT NULL DEFAULT 'active',
        created_by_membership_id  INT UNSIGNED NULL,
        modified_by_membership_id INT UNSIGNED NULL,
        deleted_by_membership_id  INT UNSIGNED NULL,
        created_at           DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP()),
        modified_at          DATETIME NULL,
        deleted_at           DATETIME NULL,
        PRIMARY KEY (id),
        INDEX mnp_gym_idx (gym_id),
        INDEX mnp_member_idx (member_id),
        CONSTRAINT mnp_gym_fk    FOREIGN KEY (gym_id)     REFERENCES gyms(id) ON DELETE CASCADE,
        CONSTRAINT mnp_member_fk FOREIGN KEY (member_id)  REFERENCES members(id) ON DELETE CASCADE,
        CONSTRAINT mnp_tpl_fk    FOREIGN KEY (template_id) REFERENCES nutrition_plan_templates(id) ON DELETE SET NULL,
        CONSTRAINT chk_mnp_status CHECK (status IN ('active','completed','deleted'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
  }

  if (!await knex.schema.hasTable('member_nutrition_plan_days')) {
    await knex.raw(`
      CREATE TABLE member_nutrition_plan_days (
        id                         INT UNSIGNED NOT NULL AUTO_INCREMENT,
        gym_id                     CHAR(36) NOT NULL,
        member_nutrition_plan_id   INT UNSIGNED NOT NULL,
        weekday                    INT UNSIGNED NOT NULL,
        position                   INT UNSIGNED NOT NULL DEFAULT 1,
        PRIMARY KEY (id),
        INDEX mnpd_gym_idx (gym_id),
        INDEX mnpd_plan_idx (member_nutrition_plan_id),
        CONSTRAINT mnpd_gym_fk  FOREIGN KEY (gym_id) REFERENCES gyms(id) ON DELETE CASCADE,
        CONSTRAINT mnpd_plan_fk FOREIGN KEY (member_nutrition_plan_id) REFERENCES member_nutrition_plans(id) ON DELETE CASCADE,
        -- weekday 0–6 = Mon–Sun; 7 = "All Days" sentinel (same convention as nutrition_plan_template_days)
        CONSTRAINT chk_mnpd_weekday CHECK (weekday BETWEEN 0 AND 7)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
  }

  if (!await knex.schema.hasTable('member_nutrition_plan_meals')) {
    await knex.raw(`
      CREATE TABLE member_nutrition_plan_meals (
        id                              INT UNSIGNED NOT NULL AUTO_INCREMENT,
        gym_id                          CHAR(36) NOT NULL,
        member_nutrition_plan_day_id    INT UNSIGNED NOT NULL,
        meal_type                       VARCHAR(50) NULL,
        display_name                    VARCHAR(255) NOT NULL,
        notes                           TEXT NULL,
        position                        INT UNSIGNED NOT NULL DEFAULT 1,
        PRIMARY KEY (id),
        INDEX mnpm_gym_idx (gym_id),
        INDEX mnpm_day_idx (member_nutrition_plan_day_id),
        CONSTRAINT mnpm_gym_fk  FOREIGN KEY (gym_id) REFERENCES gyms(id) ON DELETE CASCADE,
        CONSTRAINT mnpm_day_fk  FOREIGN KEY (member_nutrition_plan_day_id) REFERENCES member_nutrition_plan_days(id) ON DELETE CASCADE,
        CONSTRAINT chk_mnpm_meal_type CHECK (meal_type IS NULL OR meal_type IN ('recien_levantado','breakfast','media_manana','lunch','snack','dinner','antes_de_dormir'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
  }

  if (!await knex.schema.hasTable('member_nutrition_plan_meal_items')) {
    await knex.raw(`
      CREATE TABLE member_nutrition_plan_meal_items (
        id                        INT UNSIGNED NOT NULL AUTO_INCREMENT,
        gym_id                    CHAR(36) NOT NULL,
        meal_id                   INT UNSIGNED NOT NULL,
        nutrition_library_item_id INT UNSIGNED NOT NULL,
        component_type            VARCHAR(30) NOT NULL,
        quantity                  DECIMAL(8,2) NULL,
        unit                      VARCHAR(20) NULL DEFAULT 'g',
        position                  INT UNSIGNED NOT NULL DEFAULT 1,
        PRIMARY KEY (id),
        INDEX mnpmi_gym_idx (gym_id),
        INDEX mnpmi_meal_idx (meal_id),
        CONSTRAINT mnpmi_gym_fk  FOREIGN KEY (gym_id) REFERENCES gyms(id) ON DELETE CASCADE,
        CONSTRAINT mnpmi_meal_fk FOREIGN KEY (meal_id) REFERENCES member_nutrition_plan_meals(id) ON DELETE CASCADE,
        CONSTRAINT mnpmi_lib_fk  FOREIGN KEY (nutrition_library_item_id) REFERENCES nutrition_library_items(id) ON DELETE RESTRICT,
        CONSTRAINT chk_mnpmi_comp CHECK (component_type IN ('main_dish','side','sauce','additional'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
  }

  if (!await knex.schema.hasTable('member_nutrition_plan_restrictions')) {
    await knex.raw(`
      CREATE TABLE member_nutrition_plan_restrictions (
        id                        INT UNSIGNED NOT NULL AUTO_INCREMENT,
        gym_id                    CHAR(36) NOT NULL,
        member_nutrition_plan_id  INT UNSIGNED NOT NULL,
        nutrition_library_item_id INT UNSIGNED NOT NULL,
        applies_all_days          TINYINT NOT NULL DEFAULT 1,
        position                  INT UNSIGNED NOT NULL DEFAULT 1,
        PRIMARY KEY (id),
        INDEX mnpr_gym_idx (gym_id),
        INDEX mnpr_plan_idx (member_nutrition_plan_id),
        CONSTRAINT mnpr_gym_fk  FOREIGN KEY (gym_id) REFERENCES gyms(id) ON DELETE CASCADE,
        CONSTRAINT mnpr_plan_fk FOREIGN KEY (member_nutrition_plan_id) REFERENCES member_nutrition_plans(id) ON DELETE CASCADE,
        CONSTRAINT mnpr_lib_fk  FOREIGN KEY (nutrition_library_item_id) REFERENCES nutrition_library_items(id) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
  }

  if (!await knex.schema.hasTable('member_nutrition_plan_goals')) {
    await knex.raw(`
      CREATE TABLE member_nutrition_plan_goals (
        id                       INT UNSIGNED NOT NULL AUTO_INCREMENT,
        gym_id                   CHAR(36) NOT NULL,
        member_nutrition_plan_id INT UNSIGNED NOT NULL,
        item_name                VARCHAR(255) NOT NULL,
        quantity                 DECIMAL(8,2) NOT NULL,
        unit                     VARCHAR(50) NOT NULL,
        frequency                VARCHAR(50) NOT NULL DEFAULT 'daily',
        applies_all_days         TINYINT NOT NULL DEFAULT 1,
        position                 INT UNSIGNED NOT NULL DEFAULT 1,
        PRIMARY KEY (id),
        INDEX mnpg_gym_idx (gym_id),
        INDEX mnpg_plan_idx (member_nutrition_plan_id),
        CONSTRAINT mnpg_gym_fk  FOREIGN KEY (gym_id) REFERENCES gyms(id) ON DELETE CASCADE,
        CONSTRAINT mnpg_plan_fk FOREIGN KEY (member_nutrition_plan_id) REFERENCES member_nutrition_plans(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
  }
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('member_nutrition_plan_goals');
  await knex.schema.dropTableIfExists('member_nutrition_plan_restrictions');
  await knex.schema.dropTableIfExists('member_nutrition_plan_meal_items');
  await knex.schema.dropTableIfExists('member_nutrition_plan_meals');
  await knex.schema.dropTableIfExists('member_nutrition_plan_days');
  await knex.schema.dropTableIfExists('member_nutrition_plans');

  // Revert child table gym_id to NOT NULL (best-effort — won't restore old FK names)
  const childTables = [
    'nutrition_plan_template_goals',
    'nutrition_plan_template_restrictions',
    'nutrition_plan_template_meal_items',
    'nutrition_plan_template_meals',
    'nutrition_plan_template_days',
  ];
  for (const table of childTables) {
    await knex.raw(`ALTER TABLE \`${table}\` MODIFY COLUMN gym_id CHAR(36) NOT NULL`).catch(() => {});
  }

  // Revert templates
  await knex.raw('ALTER TABLE nutrition_plan_templates DROP FOREIGN KEY npt_cloned_from_fk').catch(() => {});
  await knex.raw('ALTER TABLE nutrition_plan_templates DROP COLUMN cloned_from_id').catch(() => {});
  await knex.raw('ALTER TABLE nutrition_plan_templates MODIFY COLUMN gym_id CHAR(36) NOT NULL').catch(() => {});

  // Revert nutrition_library_items
  await knex.raw('ALTER TABLE nutrition_library_items DROP COLUMN modified_at').catch(() => {});
  await knex.raw('ALTER TABLE nutrition_library_items DROP CHECK chk_nli_status').catch(() => {});
  await knex.raw('ALTER TABLE nutrition_library_items DROP COLUMN status').catch(() => {});
  await knex.raw('DROP INDEX nli_gym_name_cat ON nutrition_library_items').catch(() => {});
  await knex.raw('ALTER TABLE nutrition_library_items DROP FOREIGN KEY nli_gym_fk').catch(() => {});
  await knex.raw('ALTER TABLE nutrition_library_items DROP COLUMN gym_id').catch(() => {});
  await knex.raw("CREATE UNIQUE INDEX nli_name_category_unique ON nutrition_library_items (name, category)").catch(() => {});
};
