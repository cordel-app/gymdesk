/**
 * #643: Translate Nutrition Library Content.
 *
 * `nutrition_library_items.name` is a single free-text string (English), and it
 * is the only human-readable field on the row. This adds per-locale names for
 * the same underlying item — no second item per language — using the same
 * global-catalogue + junction shape already used for categories (#501) and
 * nutritional qualities (#293), so adding a fourth locale later is data rather
 * than DDL.
 *
 * `name` on the item row stays the base (English) value and keeps carrying the
 * `nli_gym_name_unique` uniqueness constraint. A locale with no row here falls
 * back to it at read time, so nothing ever renders blank.
 *
 * Only the system items (`gym_id IS NULL`) are seeded: gym-created items keep a
 * single entered name and simply display it in every locale. Category and
 * quality names are slug-keyed catalogues rendered from the apps' locale files
 * (`nutrition_library.category_*` / `quality_*`, already present in en/es/ca),
 * so they need no rows here.
 *
 * The seed is `INSERT IGNORE ... SELECT`, matched on the system item's unique
 * name: a re-run is a no-op, an item that has since been renamed or deleted is
 * skipped rather than failing the migration, and a translation an admin has
 * already edited is never overwritten. A translation equal to the base name
 * (Tofu, Pasta, Quinoa) is deliberately left unseeded — see the loop below.
 */

const TABLE = 'nutrition_library_item_translations';

/**
 * Spanish and Catalan names for the 32 system items seeded in migration 078,
 * keyed by their English (base) name. Food names only — no branding or
 * gym-specific wording.
 */
const SEED = [
  // Main dishes
  { en: 'Chicken',        es: 'Pollo',              ca: 'Pollastre' },
  { en: 'Beef',           es: 'Ternera',            ca: 'Vedella' },
  { en: 'Turkey',         es: 'Pavo',               ca: 'Gall dindi' },
  { en: 'Salmon',         es: 'Salmón',             ca: 'Salmó' },
  { en: 'Tuna',           es: 'Atún',               ca: 'Tonyina' },
  { en: 'Eggs',           es: 'Huevos',             ca: 'Ous' },
  { en: 'Tofu',           es: 'Tofu',               ca: 'Tofu' },
  // Sides
  { en: 'Rice',           es: 'Arroz',              ca: 'Arròs' },
  { en: 'Brown Rice',     es: 'Arroz integral',     ca: 'Arròs integral' },
  { en: 'Vegetables',     es: 'Verduras',           ca: 'Verdures' },
  { en: 'Salad',          es: 'Ensalada',           ca: 'Amanida' },
  { en: 'Potatoes',       es: 'Patatas',            ca: 'Patates' },
  { en: 'Sweet Potatoes', es: 'Boniatos',           ca: 'Moniatos' },
  { en: 'Pasta',          es: 'Pasta',              ca: 'Pasta' },
  { en: 'Quinoa',         es: 'Quinoa',             ca: 'Quinoa' },
  // Sauces
  { en: 'Tomato Sauce',   es: 'Salsa de tomate',    ca: 'Salsa de tomàquet' },
  { en: 'Yogurt Sauce',   es: 'Salsa de yogur',     ca: 'Salsa de iogurt' },
  { en: 'Olive Oil',      es: 'Aceite de oliva',    ca: "Oli d'oliva" },
  { en: 'Mustard',        es: 'Mostaza',            ca: 'Mostassa' },
  { en: 'Hot Sauce',      es: 'Salsa picante',      ca: 'Salsa picant' },
  // Drinks
  { en: 'Water',          es: 'Agua',               ca: 'Aigua' },
  { en: 'Coffee',         es: 'Café',               ca: 'Cafè' },
  { en: 'Tea',            es: 'Té',                 ca: 'Te' },
  { en: 'Juice',          es: 'Zumo',               ca: 'Suc' },
  // Desserts
  { en: 'Fruit',          es: 'Fruta',              ca: 'Fruita' },
  { en: 'Yogurt',         es: 'Yogur',              ca: 'Iogurt' },
  { en: 'Oats',           es: 'Avena',              ca: 'Civada' },
  { en: 'Honey',          es: 'Miel',               ca: 'Mel' },
  // Other
  { en: 'Bread',          es: 'Pan',                ca: 'Pa' },
  { en: 'Nuts',           es: 'Frutos secos',       ca: 'Fruita seca' },
  { en: 'Dairy',          es: 'Lácteos',            ca: 'Làctics' },
  { en: 'Sugar',          es: 'Azúcar',             ca: 'Sucre' },
];

/**
 * `nutrition_library_items` was created by knex (migration 078) without an
 * explicit charset, so its `name` inherits the schema default. This table's
 * `name` is `COALESCE`d with it on every read (`localizedNameSql`), and MySQL
 * raises ER_CANT_AGGREGATE_2COLLATIONS when the two sides differ — which would
 * break ~30 queries across five routers at runtime rather than here. So take
 * the collation from the column we fall back to instead of assuming one.
 */
async function baseNameCollation(knex) {
  const [rows] = await knex.raw(
    `SELECT CHARACTER_SET_NAME, COLLATION_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'nutrition_library_items'
       AND COLUMN_NAME = 'name'`,
  );
  const col = rows[0];
  if (!col?.COLLATION_NAME) {
    throw new Error('Cannot read nutrition_library_items.name collation — is migration 078 applied?');
  }
  // Identifiers, not values: reject anything that isn't a plain MySQL name
  // before it reaches the DDL below.
  if (!/^[A-Za-z0-9_]+$/.test(col.COLLATION_NAME) || !/^[A-Za-z0-9_]+$/.test(col.CHARACTER_SET_NAME)) {
    throw new Error(`Unexpected charset/collation on nutrition_library_items.name: ${col.CHARACTER_SET_NAME}/${col.COLLATION_NAME}`);
  }
  return col;
}

exports.up = async (knex) => {
  if (!await knex.schema.hasTable(TABLE)) {
    const { CHARACTER_SET_NAME: charset, COLLATION_NAME: collation } = await baseNameCollation(knex);
    await knex.raw(`
      CREATE TABLE ${TABLE} (
        item_id     INT UNSIGNED NOT NULL,
        locale      VARCHAR(10)  NOT NULL,
        name        VARCHAR(255) CHARACTER SET ${charset} COLLATE ${collation} NOT NULL,
        created_at  DATETIME     NOT NULL DEFAULT (UTC_TIMESTAMP()),
        modified_at DATETIME     NULL,
        PRIMARY KEY (item_id, locale),
        KEY nlit_locale_name (locale, name),
        CONSTRAINT nlit_item_fk FOREIGN KEY (item_id)
          REFERENCES nutrition_library_items(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=${charset} COLLATE=${collation}
    `);
  }

  // Seeded per (item, locale) pair rather than in one multi-row statement so a
  // renamed or soft-deleted system item simply matches nothing.
  for (const row of SEED) {
    for (const locale of ['es', 'ca']) {
      // A translation identical to the base name gets no row: the COALESCE
      // already resolves to the same string, and a row would *pin* it — a later
      // rename of the base item (Tofu → Firm Tofu) would keep showing the stale
      // name to es/ca viewers forever, while no row inherits the correction.
      if (row[locale] === row.en) continue;
      await knex.raw(
        `INSERT IGNORE INTO ${TABLE} (item_id, locale, name)
         SELECT id, ?, ? FROM nutrition_library_items
         WHERE gym_id IS NULL AND name = ?`,
        [locale, row[locale], row.en],
      );
    }
  }

  // A system item renamed by a superadmin (or created after this seed was
  // written) matches nothing above and simply falls back to its base name.
  // That is intended, but say so here rather than leaving it to surface as a
  // puzzling test failure later.
  const [[{ missing }]] = await knex.raw(`
    SELECT COUNT(*) AS missing
    FROM nutrition_library_items nli
    CROSS JOIN (SELECT 'es' AS locale UNION ALL SELECT 'ca') l
    WHERE nli.gym_id IS NULL AND nli.status != 'deleted'
      AND nli.name NOT IN (${SEED.map(() => '?').join(',')})
      AND NOT EXISTS (
        SELECT 1 FROM ${TABLE} t WHERE t.item_id = nli.id AND t.locale = l.locale
      )
  `, SEED.map((r) => r.en));
  if (missing > 0) {
    console.warn(
      `[166] ${missing} system item/locale pair(s) have no translation — ` +
      'those items fall back to their base English name.',
    );
  }
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists(TABLE);
};
