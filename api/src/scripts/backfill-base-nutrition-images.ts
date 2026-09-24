/**
 * One-time operator backfill: every Base Nutrition Library food gets an image in
 * Cloudflare R2 (#715 §3–§4).
 *
 *   npm run nutrition:base-images -- [--dry-run] [--from <dir>] [--force]
 *                                     [--limit N] [--only <id,id,…>]
 *
 * It discovers the foods from the database (`nutrition_library_items WHERE
 * gym_id IS NULL`) — there is no seed list in the repo and none is wanted — then
 * for each one that has no image yet:
 *
 *   1. computes `cordel/Nutrition/<food_id>-<sanitized name>.png`,
 *   2. takes the artwork from `--from <dir>` when a matching file is there, and
 *      otherwise renders it with `domain/nutritionImageArt.ts`,
 *   3. uploads it, and
 *   4. stores the resulting Cloudflare URL in `nutrition_library_items.image_url`.
 *
 * **Idempotent** (§4): a food whose `image_url` is already set is counted as
 * *already present* and skipped, so re-running costs a single SELECT per food
 * and changes nothing. `--force` regenerates regardless, for the case where the
 * artwork itself changed.
 *
 * **One failure does not abort the run** (§4): every food is attempted, failures
 * are collected with their id and name, and the process exits non-zero if any
 * food failed — so a scheduled or CI invocation still surfaces it.
 *
 * Why a script and not a Knex migration: a migration is deterministic, offline
 * SQL, and `npm run db:migrate` must not depend on a third-party service or a
 * network round-trip per row. The thread's own answer says the same ("do not put
 * image generation inside a Knex migration").
 */

import { readdirSync, readFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { config } from 'dotenv';
import { db } from '../infra/db';
import {
  buildBaseNutritionImageKey,
  baseNutritionFolderKeys,
  validateBaseNutritionImage,
  BASE_NUTRITION_IMAGE_MIME,
  BASE_NUTRITION_IMAGE_REJECTION_MESSAGES,
  sanitizeNutritionImageName,
} from '../domain/baseNutritionImages';
import { renderNutritionImage } from '../domain/nutritionImageArt';
import {
  buildStorageObjectUrl,
  ensureStorageFolders,
  getMissingStorageConfigKeys,
  isStorageConfigured,
  uploadStorageObject,
} from '../infra/storage';

config();

interface BaseFood {
  id: number;
  name: string;
  image_url: string | null;
  categories: string[];
  qualities: string[];
}

export interface BackfillOptions {
  dryRun: boolean;
  force: boolean;
  /** Directory of supplied artwork, matched by food id or sanitized name. */
  fromDir: string | null;
  limit: number | null;
  /** Restrict the run to these food ids — re-doing one food, rather than all. */
  ids: number[] | null;
}

export interface BackfillCounters {
  discovered: number;
  alreadyPresent: number;
  generated: number;
  supplied: number;
  uploaded: number;
  failed: { id: number; name: string; error: string }[];
}

export function parseArgs(argv: string[]): BackfillOptions {
  const options: BackfillOptions = { dryRun: false, force: false, fromDir: null, limit: null, ids: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--force') options.force = true;
    else if (arg === '--from') { options.fromDir = argv[i + 1] ?? null; i += 1; }
    else if (arg === '--limit') { options.limit = Number(argv[i + 1]); i += 1; }
    else if (arg.startsWith('--from=')) options.fromDir = arg.slice('--from='.length);
    else if (arg.startsWith('--limit=')) options.limit = Number(arg.slice('--limit='.length));
    else if (arg === '--only') { options.ids = parseIds(argv[i + 1]); i += 1; }
    else if (arg.startsWith('--only=')) options.ids = parseIds(arg.slice('--only='.length));
  }
  if (options.limit !== null && (!Number.isInteger(options.limit) || options.limit <= 0)) {
    throw new Error('--limit must be a positive integer');
  }
  return options;
}

function parseIds(value: string | undefined): number[] {
  const ids = (value ?? '').split(',').map((part) => Number(part.trim())).filter((n) => Number.isInteger(n) && n > 0);
  if (ids.length === 0) throw new Error('--only takes a comma-separated list of food ids');
  return ids;
}

/**
 * Every base food, with the category and quality slugs the renderer reads.
 * `status != 'deleted'` because a deleted food is not shown anywhere and does
 * not need an object in the bucket.
 */
export async function loadBaseFoods(limit: number | null, onlyIds: number[] | null = null): Promise<BaseFood[]> {
  // `onlyIds` are validated integers (parseIds), and LIMIT cannot be a `?`
  // parameter in MySQL 8's prepared-statement protocol — hence the literals.
  const only = onlyIds && onlyIds.length > 0 ? `AND id IN (${onlyIds.join(', ')})` : '';
  const { rows } = await db.query<{ id: number; name: string; image_url: string | null }>(
    `SELECT id, name, image_url
       FROM nutrition_library_items
      WHERE gym_id IS NULL AND status != 'deleted' ${only}
      ORDER BY id ASC
      ${limit !== null ? `LIMIT ${limit}` : ''}`,
  );
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);
  const placeholders = ids.map(() => '?').join(', ');
  const [{ rows: categoryRows }, { rows: qualityRows }] = await Promise.all([
    db.query<{ item_id: number; slug: string }>(
      `SELECT m.item_id, c.slug
         FROM nutrition_library_item_categories m
         JOIN nutrition_library_categories c ON c.id = m.category_id
        WHERE m.item_id IN (${placeholders})
        ORDER BY c.id`,
      ids,
    ),
    db.query<{ item_id: number; slug: string }>(
      `SELECT m.item_id, q.slug
         FROM nutrition_library_item_qualities m
         JOIN nutritional_qualities q ON q.id = m.quality_id
        WHERE m.item_id IN (${placeholders})
        ORDER BY q.id`,
      ids,
    ),
  ]);

  const categories = new Map<number, string[]>();
  for (const row of categoryRows) {
    categories.set(row.item_id, [...(categories.get(row.item_id) ?? []), row.slug]);
  }
  const qualities = new Map<number, string[]>();
  for (const row of qualityRows) {
    qualities.set(row.item_id, [...(qualities.get(row.item_id) ?? []), row.slug]);
  }

  return rows.map((row) => ({
    ...row,
    categories: categories.get(row.id) ?? [],
    qualities: qualities.get(row.id) ?? [],
  }));
}

/**
 * Supplied artwork for one food, or null. A file matches when its base name is
 * the food's id, the food's sanitized name, or `<id>-<sanitized name>` — the
 * three spellings an operator preparing a folder would reasonably use. Only
 * `.png` is considered, because only PNG is accepted.
 */
export function findSuppliedImage(dir: string, food: { id: number; name: string }): Buffer | null {
  const wanted = new Set([
    String(food.id),
    sanitizeNutritionImageName(food.name),
    `${food.id}-${sanitizeNutritionImageName(food.name)}`,
  ].map((candidate) => candidate.toLowerCase()));

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err: any) {
    throw new Error(`Cannot read --from directory ${dir}: ${err.message}`);
  }
  for (const entry of entries) {
    if (extname(entry).toLowerCase() !== '.png') continue;
    if (wanted.has(basename(entry, extname(entry)).toLowerCase())) {
      return readFileSync(join(dir, entry));
    }
  }
  return null;
}

export async function backfillBaseNutritionImages(
  options: BackfillOptions,
  log: (message: string) => void = console.log,
): Promise<BackfillCounters> {
  const counters: BackfillCounters = {
    discovered: 0, alreadyPresent: 0, generated: 0, supplied: 0, uploaded: 0, failed: [],
  };

  if (!options.dryRun && !isStorageConfigured()) {
    throw new Error(
      `Cloudflare storage is not configured (missing: ${getMissingStorageConfigKeys().join(', ')}). `
      + 'Set the CLOUDFLARE_R2_* environment variables, or pass --dry-run to see what would be done.',
    );
  }

  const foods = await loadBaseFoods(options.limit, options.ids);
  counters.discovered = foods.length;
  log(`Discovered ${foods.length} Base Nutrition Library food(s).`);

  const pending = foods.filter((food) => options.force || !food.image_url);
  counters.alreadyPresent = foods.length - pending.length;

  // Only when there is something to write: a re-run over a fully populated
  // library must touch the bucket exactly zero times (§4's idempotence), and
  // rewriting the folder markers would be a write.
  if (pending.length > 0 && !options.dryRun) {
    await ensureStorageFolders(baseNutritionFolderKeys());
  }

  for (const food of pending) {
    const key = buildBaseNutritionImageKey(food.id, food.name);
    try {
      const supplied = options.fromDir ? findSuppliedImage(options.fromDir, food) : null;
      const png = supplied ?? renderNutritionImage({
        name: food.name,
        categories: food.categories,
        qualities: food.qualities,
      });
      // Supplied artwork goes through exactly the checks the upload route
      // applies, so a backfilled image can never be one the API would refuse.
      const rejection = validateBaseNutritionImage(png);
      if (rejection) throw new Error(BASE_NUTRITION_IMAGE_REJECTION_MESSAGES[rejection]);

      if (supplied) counters.supplied += 1; else counters.generated += 1;

      if (options.dryRun) {
        log(`[dry-run] ${food.id} ${food.name} → ${key} (${supplied ? 'supplied' : 'generated'}, ${png.length} bytes)`);
        continue;
      }

      await uploadStorageObject(key, BASE_NUTRITION_IMAGE_MIME, png);
      await db.query(
        'UPDATE nutrition_library_items SET image_url = ?, modified_at = UTC_TIMESTAMP() WHERE id = ?',
        [buildStorageObjectUrl(key), food.id],
      );
      counters.uploaded += 1;
      log(`uploaded ${food.id} ${food.name} → ${key}`);
    } catch (err: any) {
      // §4: one food's failure never stops the rest.
      counters.failed.push({ id: food.id, name: food.name, error: err?.message ?? String(err) });
      log(`FAILED ${food.id} ${food.name}: ${err?.message ?? err}`);
    }
  }

  log('');
  log('── Base Nutrition Library image backfill ──');
  log(`  discovered:      ${counters.discovered}`);
  log(`  already present: ${counters.alreadyPresent}`);
  log(`  generated:       ${counters.generated}`);
  log(`  supplied:        ${counters.supplied}`);
  log(`  uploaded:        ${counters.uploaded}`);
  log(`  failed:          ${counters.failed.length}`);
  for (const failure of counters.failed) {
    log(`    - #${failure.id} ${failure.name}: ${failure.error}`);
  }

  return counters;
}

/* istanbul ignore next — the CLI wrapper; the work above is what tests cover. */
async function main() {
  const options = parseArgs(process.argv.slice(2));
  const counters = await backfillBaseNutritionImages(options);
  await db.end();
  process.exit(counters.failed.length > 0 ? 1 : 0);
}

// Only run when invoked directly, so the functions above can be imported by tests.
if (process.argv[1] && process.argv[1].includes('backfill-base-nutrition-images')) {
  main().catch(async (err) => {
    console.error(err);
    await db.end().catch(() => {});
    process.exit(1);
  });
}
