/**
 * #2951 stage 4 — every Professional Service has a persistent slug: the Base Professional Services
 * (`professional_services` rows with `gym_id IS NULL`) and each gym's own services (gym_id set).
 *
 * Both live in one table, so `slug` is one new column with two kinds of scope:
 *
 *   gym_id IS NULL   the Base catalogue, one scope (deleted rows included, so a slug is never reused)
 *   gym_id = G       that gym's own services, one scope per gym
 *
 * `slug_scope_key` (VIRTUAL, `IFNULL(gym_id, '')`; no gym id is empty) gives the Base rows a scope value
 * a UNIQUE index can compare, since NULLs never collide: `ps_scope_slug_unique (slug_scope_key, slug)`
 * enforces both scopes at once.
 *
 * A gym service imported from a Base one (`base_professional_service_id`) takes its Base service's
 * slug (§6); every other row is slugged from its own `name` (the seeded System services included —
 * their `system_key` is a different handle and is left alone). Imported copies are filled first so a
 * gym's own service never takes the slug its copy should carry. A taken slug gets `-2`, `-3`, … in
 * id order.
 *
 * The rule is `api/src/domain/entitySlug.ts`' (a copy, as migrations 435, 437 and 438 carry one; the
 * unit test keeps them in step). The column stays nullable, as the exercise and goal ones do, and the
 * writers are gated instead (`entity-slug.unit.test.ts`); the migration still refuses to finish while
 * a row has no slug. No name or other column is written. Safe to re-run: a filled row is never
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

const UNIQUE_KEY = 'ps_scope_slug_unique';
const FALLBACK = 'professional-service';

async function hasIndex(knex, table, name) {
  const [rows] = await knex.raw(
    `SELECT 1 FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1`,
    [table, name],
  );
  return rows.length > 0;
}

exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('professional_services', 'slug'))) {
    await knex.raw('ALTER TABLE professional_services ADD COLUMN slug VARCHAR(120) NULL');
  }
  if (!(await knex.schema.hasColumn('professional_services', 'slug_scope_key'))) {
    await knex.raw(
      "ALTER TABLE professional_services ADD COLUMN slug_scope_key CHAR(36) AS (IFNULL(gym_id, '')) VIRTUAL",
    );
  }

  const [rows] = await knex.raw(
    `SELECT ps.id, ps.gym_id, ps.name, ps.slug, ps.base_professional_service_id
       FROM professional_services ps
      ORDER BY (ps.gym_id IS NOT NULL), ps.gym_id, ps.id`,
  );
  const used = new Map();
  const usedFor = (gymId) => {
    const key = gymId ?? '';
    if (!used.has(key)) used.set(key, new Set());
    return used.get(key);
  };
  // Slugs already written (a re-run) keep their place, first come first served in id order.
  const toFill = [];
  for (const row of rows) {
    const scope = usedFor(row.gym_id);
    if (row.slug && !scope.has(row.slug.toLowerCase())) { scope.add(row.slug.toLowerCase()); continue; }
    toFill.push(row);
  }

  const slugById = new Map(rows.filter((r) => r.slug).map((r) => [r.id, r.slug]));
  const fill = async (row, preferred) => {
    const scope = usedFor(row.gym_id);
    const slug = nextAvailableSlug(preferred.toLowerCase(), scope);
    scope.add(slug);
    slugById.set(row.id, slug);
    if (row.slug) console.log(`[439] professional service ${row.id} shared slug "${row.slug}" in its scope; now "${slug}"`);
    await knex.raw('UPDATE professional_services SET slug = ? WHERE id = ?', [slug, row.id]);
  };

  // 1. Base services (ordered first), so an imported copy can read its Base service's slug.
  for (const row of toFill.filter((r) => r.gym_id === null)) {
    await fill(row, generateSlug(row.name, FALLBACK));
  }
  // 2. Imported gym copies carry their Base service's slug (§6).
  const gymRows = toFill.filter((r) => r.gym_id !== null);
  for (const row of gymRows.filter((r) => r.base_professional_service_id && slugById.get(r.base_professional_service_id))) {
    await fill(row, slugById.get(row.base_professional_service_id));
  }
  // 3. Every other gym service from its own name.
  for (const row of gymRows) {
    if (slugById.has(row.id)) continue;
    await fill(row, generateSlug(row.name, FALLBACK));
  }

  const [[{ missing }]] = await knex.raw(
    "SELECT COUNT(*) AS missing FROM professional_services WHERE slug IS NULL OR slug = ''",
  );
  if (Number(missing) > 0) throw new Error(`[439] ${missing} professional service(s) have no slug`);

  if (!(await hasIndex(knex, 'professional_services', UNIQUE_KEY))) {
    await knex.raw(`ALTER TABLE professional_services ADD UNIQUE KEY ${UNIQUE_KEY} (slug_scope_key, slug)`);
  }
};

exports.down = async (knex) => {
  // Unlike 437/438, whose slug columns predate them, this migration created `slug`, so `down`
  // drops it to leave the table as it found it.
  if (await hasIndex(knex, 'professional_services', UNIQUE_KEY)) {
    await knex.raw(`ALTER TABLE professional_services DROP INDEX ${UNIQUE_KEY}`);
  }
  if (await knex.schema.hasColumn('professional_services', 'slug_scope_key')) {
    await knex.raw('ALTER TABLE professional_services DROP COLUMN slug_scope_key');
  }
  if (await knex.schema.hasColumn('professional_services', 'slug')) {
    await knex.raw('ALTER TABLE professional_services DROP COLUMN slug');
  }
};
