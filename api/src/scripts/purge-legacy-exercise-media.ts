/**
 * #1420 (last stage) — removes the legacy exercise media objects from the bucket.
 *
 *   npm run exercises:purge-legacy-media -- [--execute]
 *
 * A dry run unless `--execute`. Before #1420 an exercise's media was one 2048 PNG
 * pair and one MP4 with a 512 PNG poster; the gender-specific WebP media replaces
 * it and **nothing is migrated** (the existing media is test data), so those
 * objects are dead weight in R2 once migration 277 drops the columns that
 * pointed at them.
 *
 * It decides from object keys alone (`domain/legacyExerciseMediaPurge.ts`), not
 * from the dropped columns, so it runs before or after that migration and a
 * second run finds nothing. It scans only the exercise media folders of `cordel/`
 * and of every gym with a `storage_folder_prefix`, never deletes a gender-specific
 * object, a folder marker, or anything outside those folders, and keeps going
 * after a failure (the exit code is non-zero if any object could not be removed).
 *
 * Against a deployed bucket it runs from the VPS through
 * `.github/workflows/exercises-purge-legacy-media.yml` as
 * `node dist/scripts/purge-legacy-exercise-media.js`; `import 'dotenv/config'`
 * comes first for the reason `import-free-exercise-db.ts` documents.
 */
import 'dotenv/config';
import { db } from '../infra/db';
import { PLATFORM_STORAGE_ROOT } from '../infra/storage';
import {
  deleteStorageObject,
  getMissingStorageConfigKeys,
  isStorageConfigured,
  listStorageObjects,
} from '../infra/storage';
import { exerciseMediaFolders, isLegacyExerciseMediaKey } from '../domain/legacyExerciseMediaPurge';

/** A runaway prefix must not become an unbounded scan; no exercise folder is near this. */
const MAX_KEYS_PER_FOLDER = 100_000;

export interface PurgeReport {
  roots: number;
  folders: number;
  scanned: number;
  legacy: number;
  deleted: number;
  failed: { key: string; error: string }[];
}

export async function purgeLegacyExerciseMedia(options: { execute: boolean; log?: (line: string) => void }): Promise<PurgeReport> {
  const log = options.log ?? (() => {});
  const report: PurgeReport = { roots: 0, folders: 0, scanned: 0, legacy: 0, deleted: 0, failed: [] };

  const { rows } = await db.query<{ storage_folder_prefix: string }>(
    'SELECT storage_folder_prefix FROM gyms WHERE storage_folder_prefix IS NOT NULL',
  );
  const roots = [PLATFORM_STORAGE_ROOT, ...rows.map((r) => r.storage_folder_prefix)];
  report.roots = roots.length;

  for (const root of roots) {
    for (const { folder, legacyCase } of exerciseMediaFolders(root)) {
      report.folders += 1;
      const objects = await listStorageObjects(folder, MAX_KEYS_PER_FOLDER);
      for (const object of objects) {
        report.scanned += 1;
        if (!isLegacyExerciseMediaKey(object.key, legacyCase)) continue;
        report.legacy += 1;
        if (!options.execute) {
          log(`would delete ${object.key}`);
          continue;
        }
        try {
          await deleteStorageObject(object.key);
          report.deleted += 1;
          log(`deleted ${object.key}`);
        } catch (err: any) {
          report.failed.push({ key: object.key, error: String(err?.message ?? err) });
        }
      }
    }
  }
  return report;
}

async function main() {
  const execute = process.argv.includes('--execute');
  if (!isStorageConfigured()) {
    console.error(`Cloudflare storage is not configured (missing: ${getMissingStorageConfigKeys().join(', ')}).`);
    process.exitCode = 1;
    return;
  }
  const report = await purgeLegacyExerciseMedia({ execute, log: (line) => console.log(line) });
  console.log(
    `${execute ? 'Purged' : 'Dry run —'} ${report.roots} roots, ${report.folders} folders, ` +
    `${report.scanned} objects scanned, ${report.legacy} legacy, ${report.deleted} deleted, ${report.failed.length} failed.`,
  );
  for (const failure of report.failed) console.error(`FAILED ${failure.key}: ${failure.error}`);
  if (report.failed.length > 0) process.exitCode = 1;
}

if (require.main === module) {
  main()
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => db.end());
}
