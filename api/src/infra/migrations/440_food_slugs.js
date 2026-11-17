/**
 * #2951 stage 5 — every Nutrition Library food has a persistent slug: the Base foods
 * (`base_nutrition_library_items`, Cordel's) and each gym's own foods (`nutrition_library_items`,
 * gym_id set).
 *
 *   base_nutrition_library_items   one scope (deleted rows included, so a slug is never reused);
 *                                  `base_nli_slug_unique (slug)`
 *   nutrition_library_items        one scope per gym; `nli_gym_slug_unique (gym_id, slug)`
 *
 * A gym does not import Base foods (it reads them through `nutrition_library_item_catalogue`), so
 * every row is slugged from its own `name`; a taken slug gets `-2`, `-3`, … in id order. The legacy
 * table's `gym_id IS NULL` rows (the Base id placeholder, inserted and deleted in one request; the
 * legacy System foods are gone since migration 334) are left with none: a NULL gym never collides in
 * the UNIQUE key, and no reader shows them.
 *
 * `nutrition_library_item_catalogue` is recreated with `slug` appended, so a gym's list and Details
 * read it for both kinds of row; the view is otherwise migration 325's, unchanged.
 *
 * The rule is `api/src/domain/entitySlug.ts`' (a copy, as migrations 435 and 437–439 carry one; the
 * unit test keeps them in step). The columns stay nullable, as the other stages' do, and the writers
 * are gated instead (`entity-slug.unit.test.ts`); the migration still refuses to finish while a row
 * in scope has no slug. No name or other column is written. Safe to re-run: a filled row is never
 * rewritten.
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

const FALLBACK = 'food';
const BASE_KEY = 'base_nli_slug_unique';
const GYM_KEY = 'nli_gym_slug_unique';

async function hasIndex(knex, table, name) {
  const [rows] = await knex.raw(
    `SELECT 1 FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1`,
    [table, name],
  );
  return rows.length > 0;
}

/** Fills `table`'s missing slugs, one scope per `scopeOf(row)`, in id order. */
async function backfill(knex, table, rows, scopeOf) {
  const used = new Map();
  const usedFor = (row) => {
    const key = scopeOf(row);
    if (!used.has(key)) used.set(key, new Set());
    return used.get(key);
  };
  const toFill = [];
  // Slugs already written (a re-run) keep their place, first come first served in id order.
  for (const row of rows) {
    const scope = usedFor(row);
    if (row.slug && !scope.has(row.slug.toLowerCase())) { scope.add(row.slug.toLowerCase()); continue; }
    toFill.push(row);
  }
  for (const row of toFill) {
    const scope = usedFor(row);
    const slug = nextAvailableSlug(generateSlug(row.name, FALLBACK), scope);
    scope.add(slug);
    if (row.slug) console.log(`[440] ${table} ${row.id} shared slug "${row.slug}" in its scope; now "${slug}"`);
    await knex.raw(`UPDATE ${table} SET slug = ? WHERE id = ?`, [slug, row.id]);
  }
}

const CATALOGUE_VIEW = (withSlug) => `
  CREATE OR REPLACE VIEW nutrition_library_item_catalogue AS
  SELECT id, NULL AS gym_id, name, created_at,
         IF(deleted_at IS NULL, 'active', 'deleted') AS status,
         modified_at, image_url, description, created_by, modified_by, deleted_by, deleted_at${withSlug ? ', slug' : ''}
    FROM base_nutrition_library_items
  UNION ALL
  SELECT id, gym_id, name, created_at, status,
         modified_at, image_url, description, created_by, modified_by, deleted_by, deleted_at${withSlug ? ', slug' : ''}
    FROM nutrition_library_items
   WHERE gym_id IS NOT NULL
`;

exports.up = async (knex) => {
  for (const table of ['base_nutrition_library_items', 'nutrition_library_items']) {
    if (!(await knex.schema.hasColumn(table, 'slug'))) {
      await knex.raw(`ALTER TABLE ${table} ADD COLUMN slug VARCHAR(120) NULL`);
    }
  }

  const [baseRows] = await knex.raw('SELECT id, name, slug FROM base_nutrition_library_items ORDER BY id');
  await backfill(knex, 'base_nutrition_library_items', baseRows, () => '');

  const [gymRows] = await knex.raw(
    'SELECT id, gym_id, name, slug FROM nutrition_library_items WHERE gym_id IS NOT NULL ORDER BY gym_id, id',
  );
  await backfill(knex, 'nutrition_library_items', gymRows, (r) => r.gym_id);

  const [[{ missing }]] = await knex.raw(
    `SELECT (SELECT COUNT(*) FROM base_nutrition_library_items WHERE slug IS NULL OR slug = '')
          + (SELECT COUNT(*) FROM nutrition_library_items WHERE gym_id IS NOT NULL AND (slug IS NULL OR slug = ''))
            AS missing`,
  );
  if (Number(missing) > 0) throw new Error(`[440] ${missing} food(s) have no slug`);

  if (!(await hasIndex(knex, 'base_nutrition_library_items', BASE_KEY))) {
    await knex.raw(`ALTER TABLE base_nutrition_library_items ADD UNIQUE KEY ${BASE_KEY} (slug)`);
  }
  if (!(await hasIndex(knex, 'nutrition_library_items', GYM_KEY))) {
    await knex.raw(`ALTER TABLE nutrition_library_items ADD UNIQUE KEY ${GYM_KEY} (gym_id, slug)`);
  }

  await knex.raw(CATALOGUE_VIEW(true));
};

exports.down = async (knex) => {
  await knex.raw(CATALOGUE_VIEW(false));
  // The `gym_id` foreign key may have adopted `nli_gym_slug_unique` as its index (its leading
  // column); give it one of its own before that key goes, or MySQL refuses the drop. The index is
  // kept after the rollback on purpose: the foreign key needs it.
  if (await hasIndex(knex, 'nutrition_library_items', GYM_KEY)
      && !(await hasIndex(knex, 'nutrition_library_items', 'nli_gym_id_index'))) {
    await knex.raw('ALTER TABLE nutrition_library_items ADD INDEX nli_gym_id_index (gym_id)');
  }
  for (const [table, key] of [['base_nutrition_library_items', BASE_KEY], ['nutrition_library_items', GYM_KEY]]) {
    if (await hasIndex(knex, table, key)) await knex.raw(`ALTER TABLE ${table} DROP INDEX ${key}`);
    if (await knex.schema.hasColumn(table, 'slug')) await knex.raw(`ALTER TABLE ${table} DROP COLUMN slug`);
  }
};
