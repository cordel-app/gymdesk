/**
 * #1817 — Base Professional Services: a Max Capacity and a name/description in
 * every product language.
 *
 *  - `professional_services.max_capacity` — nullable positive integer, a
 *    property of the definition only (no booking or capacity rule reads it).
 *    NULL = not configured, which is what every existing row means.
 *  - `professional_service_translations` — one row per `(service, locale)`,
 *    with `professional_services.name` / `description` staying the base-locale
 *    (English) value and the fallback. No backfill: no translation is invented,
 *    a locale with no row falls back to the base text at read time.
 */
exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('professional_services', 'max_capacity'))) {
    await knex.raw('ALTER TABLE professional_services ADD COLUMN max_capacity INT UNSIGNED NULL');
  }
  const [[chk]] = await knex.raw(
    `SELECT COUNT(*) AS cnt FROM information_schema.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'professional_services'
       AND CONSTRAINT_NAME = 'chk_professional_services_max_capacity'`,
  );
  if (Number(chk.cnt) === 0) {
    await knex.raw(
      `ALTER TABLE professional_services
         ADD CONSTRAINT chk_professional_services_max_capacity CHECK (max_capacity IS NULL OR max_capacity > 0)`,
    );
  }

  if (!(await knex.schema.hasTable('professional_service_translations'))) {
    await knex.raw(`
      CREATE TABLE professional_service_translations (
        professional_service_id INT UNSIGNED NOT NULL,
        locale       VARCHAR(10)  NOT NULL,
        name         VARCHAR(150) NOT NULL,
        description  TEXT NULL,
        created_at   DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP()),
        modified_at  DATETIME NULL,
        PRIMARY KEY (professional_service_id, locale),
        CONSTRAINT pst_service_fk FOREIGN KEY (professional_service_id)
          REFERENCES professional_services(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
  }
};

exports.down = async () => {};
