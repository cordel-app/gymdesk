/**
 * #2951 stage 1 — a persistent, unique `slug` on the two platform-wide catalogues that had none:
 * `payment_providers` and `base_payment_methods`. Neither has gym-specific rows, so each table is
 * one slug scope: `UNIQUE (slug)`, deleted rows included (a slug is never reused).
 *
 *   payment_providers.slug       from `name`
 *   base_payment_methods.slug    from the English translation's name, else the `code`
 *
 * The slug is generated once from the name and never regenerated (`api/src/domain/entitySlug.ts`
 * spells the same two rules for new rows: lowercase, accents removed, every run of other characters
 * one hyphen, no leading/trailing hyphen; a taken slug gets `-2`, `-3`, … in id order). No name or
 * other column is written. `gyms.slug` and `muscles.slug` already exist, are unique and are kept as
 * they are.
 *
 * Order: add the column NULL, fill every row, refuse to finish while a row has none, then make it
 * NOT NULL and add the UNIQUE key — each step is safe to re-run (a filled row is never rewritten).
 */

const SLUG_MAX = 120;

function generateSlug(name, fallback) {
  const folded = String(name ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  const slug = folded
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, '');
  return slug || fallback;
}

function nextAvailableSlug(base, used) {
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, SLUG_MAX - suffix.length).replace(/-+$/g, '')}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
}

const TABLES = [
  {
    table: 'payment_providers',
    key: 'payment_providers_slug_unique',
    fallback: 'payment-provider',
    select: 'SELECT id, slug, name AS source FROM payment_providers ORDER BY id',
  },
  {
    table: 'base_payment_methods',
    key: 'base_payment_methods_slug_unique',
    fallback: 'payment-method',
    select: `SELECT m.id, m.slug, COALESCE(t.name, m.code) AS source
               FROM base_payment_methods m
               LEFT JOIN base_payment_method_translations t
                 ON t.base_payment_method_id = m.id AND t.locale = 'en'
              ORDER BY m.id`,
  },
];

async function hasIndex(knex, table, name) {
  const [rows] = await knex.raw(
    `SELECT 1 FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1`,
    [table, name],
  );
  return rows.length > 0;
}

exports.up = async (knex) => {
  for (const { table, key, fallback, select } of TABLES) {
    if (!(await knex.schema.hasColumn(table, 'slug'))) {
      await knex.raw(`ALTER TABLE ${table} ADD COLUMN slug VARCHAR(${SLUG_MAX}) NULL`);
    }

    const [rows] = await knex.raw(select);
    const used = new Set(rows.filter((r) => r.slug).map((r) => r.slug));
    for (const row of rows) {
      if (row.slug) continue;
      const slug = nextAvailableSlug(generateSlug(row.source, fallback), used);
      used.add(slug);
      await knex.raw(`UPDATE ${table} SET slug = ? WHERE id = ? AND slug IS NULL`, [slug, row.id]);
    }

    const [[{ missing }]] = await knex.raw(`SELECT COUNT(*) AS missing FROM ${table} WHERE slug IS NULL OR slug = ''`);
    if (Number(missing) > 0) throw new Error(`[434] ${missing} row(s) of ${table} have no slug`);

    await knex.raw(`ALTER TABLE ${table} MODIFY COLUMN slug VARCHAR(${SLUG_MAX}) NOT NULL`);
    if (!(await hasIndex(knex, table, key))) {
      await knex.raw(`ALTER TABLE ${table} ADD UNIQUE KEY ${key} (slug)`);
    }
  }
};

exports.down = async (knex) => {
  for (const { table, key } of TABLES) {
    if (await hasIndex(knex, table, key)) await knex.raw(`ALTER TABLE ${table} DROP INDEX ${key}`);
    if (await knex.schema.hasColumn(table, 'slug')) await knex.raw(`ALTER TABLE ${table} DROP COLUMN slug`);
  }
};
