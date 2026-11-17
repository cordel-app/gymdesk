/**
 * #2951 stage 3 — every goal has a persistent slug: the Base Personal Goals and Base Nutrition
 * Goals (`base_personal_goals`, `base_nutrition_goals`) and each gym's own Personal Goals and
 * Nutrition Goals (`personal_goals`, `nutrition_goals`, gym_id set).
 *
 *   base_*_goals.slug          The column already exists: it is the seeded goal's label handle
 *                              (`weight_loss` → `goal_library.personal_goal_weight_loss`) and those
 *                              values are kept as they are. A Base goal Cordel created since has none;
 *                              it gets one from its name, unique within the table (deleted rows
 *                              included, so a slug is never reused). Widened to 120 like every slug
 *                              column in scope; the live-only `base_*_goals_live_slug` key stays.
 *   personal_goals.entity_slug  New. The gym tables' own `slug` column stays the System label handle
 *   nutrition_goals.entity_slug (always NULL on a gym row, `chk_*_slug_system_only`), because every
 *                              reader resolves a goal's translated label from it: a gym goal named
 *                              "Energy" holding `energy` there would be shown as the seeded Energy
 *                              label. An imported copy takes its Base goal's slug (§6), every other row
 *                              its own name; unique within the gym, enforced by
 *                              `*_gym_entity_slug_unique (gym_id, entity_slug)`.
 *
 * The two catalogue views report `entity_slug` for every row (a Base row's `slug`, a gym row's
 * `entity_slug`), the value the Details window shows.
 *
 * The rule is `api/src/domain/entitySlug.ts`' (a copy, as migrations 435 and 437 carry one; the
 * unit test keeps them in step). The new column stays nullable: the Base id reservation inserts a
 * placeholder gym row with no gym (`allocateGoalId()`), and the writers are gated instead
 * (`entity-slug.unit.test.ts`). The migration refuses to finish while a row has no slug. No name or
 * other column is written. Safe to re-run: a filled row is never rewritten.
 */

const SLUG_MAX = 120;

function generateSlug(name, fallback) {
  const folded = String(name ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '');
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

const GYM_TABLES = [
  { table: 'personal_goals', key: 'personal_goals_gym_entity_slug_unique', base: 'base_personal_goals', link: 'base_personal_goal_id' },
  { table: 'nutrition_goals', key: 'nutrition_goals_gym_entity_slug_unique', base: null, link: null },
];
const BASE_TABLES = ['base_personal_goals', 'base_nutrition_goals'];

async function hasIndex(knex, table, name) {
  const [rows] = await knex.raw(
    `SELECT 1 FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1`,
    [table, name],
  );
  return rows.length > 0;
}

async function columnLength(knex, table, column) {
  const [rows] = await knex.raw(
    `SELECT CHARACTER_MAXIMUM_LENGTH AS len FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column],
  );
  return rows.length ? Number(rows[0].len) : null;
}

exports.up = async (knex) => {
  // 1. Base goals: widen, then fill the ones Cordel created without a slug.
  for (const table of BASE_TABLES) {
    if ((await columnLength(knex, table, 'slug')) < SLUG_MAX) {
      await knex.raw(`
        ALTER TABLE ${table}
          MODIFY slug VARCHAR(${SLUG_MAX}) NULL,
          MODIFY live_slug_key VARCHAR(${SLUG_MAX})
            GENERATED ALWAYS AS (IF(deleted_at IS NULL, slug, NULL)) VIRTUAL
      `);
    }
    const [rows] = await knex.raw(`SELECT id, name, slug FROM ${table} ORDER BY id`);
    const used = new Set(rows.filter((r) => r.slug).map((r) => r.slug.toLowerCase()));
    for (const row of rows) {
      if (row.slug) continue;
      const slug = nextAvailableSlug(generateSlug(row.name, 'goal'), used);
      used.add(slug);
      await knex.raw(`UPDATE ${table} SET slug = ? WHERE id = ? AND (slug IS NULL OR slug = '')`, [slug, row.id]);
    }
    const [[{ missing }]] = await knex.raw(`SELECT COUNT(*) AS missing FROM ${table} WHERE slug IS NULL OR slug = ''`);
    if (Number(missing) > 0) throw new Error(`[438] ${missing} row(s) of ${table} have no slug`);
  }

  // 2. Gym goals: a new column, one scope per gym.
  for (const { table, key, base, link } of GYM_TABLES) {
    if (!(await knex.schema.hasColumn(table, 'entity_slug'))) {
      await knex.raw(`ALTER TABLE ${table} ADD COLUMN entity_slug VARCHAR(${SLUG_MAX}) NULL AFTER slug`);
    }
    const [rows] = await knex.raw(
      base
        ? `SELECT g.id, g.gym_id, g.name, g.entity_slug, b.slug AS base_slug
             FROM ${table} g LEFT JOIN ${base} b ON b.id = g.${link}
            WHERE g.gym_id IS NOT NULL ORDER BY g.gym_id, g.id`
        : `SELECT g.id, g.gym_id, g.name, g.entity_slug, NULL AS base_slug
             FROM ${table} g WHERE g.gym_id IS NOT NULL ORDER BY g.gym_id, g.id`,
    );
    const usedByGym = new Map();
    const usedFor = (gymId) => {
      if (!usedByGym.has(gymId)) usedByGym.set(gymId, new Set());
      return usedByGym.get(gymId);
    };
    const toFill = [];
    for (const row of rows) {
      const used = usedFor(row.gym_id);
      // Keyed lowercase: the UNIQUE index compares under the column's case-insensitive collation.
      if (row.entity_slug && !used.has(row.entity_slug.toLowerCase())) { used.add(row.entity_slug.toLowerCase()); continue; }
      toFill.push(row);
    }
    // An imported copy is filled first, so it keeps its Base goal's slug over a gym's own goal
    // whose name happens to slugify to the same value.
    toFill.sort((a, b) => String(a.gym_id).localeCompare(String(b.gym_id))
      || Number(!a.base_slug) - Number(!b.base_slug) || a.id - b.id);
    for (const row of toFill) {
      const used = usedFor(row.gym_id);
      const preferred = (row.base_slug || generateSlug(row.name, 'goal')).toLowerCase();
      const slug = nextAvailableSlug(preferred, used);
      used.add(slug);
      await knex.raw(`UPDATE ${table} SET entity_slug = ? WHERE id = ?`, [slug, row.id]);
    }
    const [[{ missing }]] = await knex.raw(
      `SELECT COUNT(*) AS missing FROM ${table} WHERE gym_id IS NOT NULL AND (entity_slug IS NULL OR entity_slug = '')`,
    );
    if (Number(missing) > 0) throw new Error(`[438] ${missing} gym row(s) of ${table} have no slug`);
    if (!(await hasIndex(knex, table, key))) {
      await knex.raw(`ALTER TABLE ${table} ADD UNIQUE KEY ${key} (gym_id, entity_slug)`);
    }
  }

  // 3. The catalogue views report the slug of every row under one name.
  await knex.raw(`
    CREATE OR REPLACE VIEW personal_goal_catalogue AS
    SELECT id, NULL AS gym_id, NULL AS base_personal_goal_id, slug, name, description,
           target_value, target_unit, target_type, image_url, image_thumbnail_url,
           IF(deleted_at IS NULL, 'active', 'deleted') AS status,
           created_at, created_by, modified_at, modified_by, deleted_at, deleted_by,
           slug AS entity_slug
      FROM base_personal_goals
    UNION ALL
    SELECT id, gym_id, base_personal_goal_id, slug, name, description,
           target_value, target_unit, target_type, image_url, image_thumbnail_url, status,
           created_at, created_by, modified_at, modified_by, deleted_at, deleted_by,
           entity_slug
      FROM personal_goals
     WHERE gym_id IS NOT NULL
  `);
  await knex.raw(`
    CREATE OR REPLACE VIEW nutrition_goal_catalogue AS
    SELECT id, NULL AS gym_id, slug, name, description, image_url, image_thumbnail_url,
           IF(deleted_at IS NULL, 'active', 'deleted') AS status,
           created_at, created_by, modified_at, modified_by, deleted_at, deleted_by,
           slug AS entity_slug
      FROM base_nutrition_goals
    UNION ALL
    SELECT id, gym_id, slug, name, description, image_url, image_thumbnail_url, status,
           created_at, created_by, modified_at, modified_by, deleted_at, deleted_by,
           entity_slug
      FROM nutrition_goals
     WHERE gym_id IS NOT NULL
  `);
};

exports.down = async (knex) => {
  // The views go back to their previous shape; the slugs written are kept (a slug is never taken back).
  await knex.raw(`
    CREATE OR REPLACE VIEW personal_goal_catalogue AS
    SELECT id, NULL AS gym_id, NULL AS base_personal_goal_id, slug, name, description,
           target_value, target_unit, target_type, image_url, image_thumbnail_url,
           IF(deleted_at IS NULL, 'active', 'deleted') AS status,
           created_at, created_by, modified_at, modified_by, deleted_at, deleted_by
      FROM base_personal_goals
    UNION ALL
    SELECT id, gym_id, base_personal_goal_id, slug, name, description,
           target_value, target_unit, target_type, image_url, image_thumbnail_url, status,
           created_at, created_by, modified_at, modified_by, deleted_at, deleted_by
      FROM personal_goals
     WHERE gym_id IS NOT NULL
  `);
  await knex.raw(`
    CREATE OR REPLACE VIEW nutrition_goal_catalogue AS
    SELECT id, NULL AS gym_id, slug, name, description, image_url, image_thumbnail_url,
           IF(deleted_at IS NULL, 'active', 'deleted') AS status,
           created_at, created_by, modified_at, modified_by, deleted_at, deleted_by
      FROM base_nutrition_goals
    UNION ALL
    SELECT id, gym_id, slug, name, description, image_url, image_thumbnail_url, status,
           created_at, created_by, modified_at, modified_by, deleted_at, deleted_by
      FROM nutrition_goals
     WHERE gym_id IS NOT NULL
  `);
  for (const { table, key } of GYM_TABLES) {
    if (await hasIndex(knex, table, key)) await knex.raw(`ALTER TABLE ${table} DROP INDEX ${key}`);
  }
};
