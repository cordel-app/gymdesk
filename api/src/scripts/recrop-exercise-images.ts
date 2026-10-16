/**
 * #1527 follow-up — re-crops the exercise images stored before exercise uploads
 * switched from `contain` (whole picture, transparent bands) to `cover`
 * (centre-cropped to the square).
 *
 *   npm run exercises:recrop-images -- [--execute]
 *
 * A dry run unless `--execute`. For every exercise (gym and Base) it reads the
 * stored 1080 master of each image column and of each video's preview, cuts off
 * the transparent bands `containedPictureBox()` finds (`domain/exerciseImageRecrop.ts`)
 * and runs the result through the same `processExerciseImage(…, { fit: 'cover' })`
 * an upload uses, overwriting the master and its 256 thumbnail **under the same
 * keys** — no row is written and no URL changes. A master with no bands (already
 * square, already re-cropped, or a cutout figure) is left alone, so a second run
 * finds nothing. It keeps going after a failure; the exit code is non-zero if any
 * object could not be re-cropped.
 *
 * Against a deployed bucket it runs from the VPS through
 * `.github/workflows/exercises-recrop-images.yml` as
 * `node dist/scripts/recrop-exercise-images.js`; `import 'dotenv/config'` comes
 * first for the reason `import-free-exercise-db.ts` documents.
 */
import 'dotenv/config';
import sharp from 'sharp';
import { db } from '../infra/db';
import {
  getMissingStorageConfigKeys,
  getStorageObject,
  isStorageConfigured,
  storageKeyFromObjectUrl,
  uploadStorageObject,
} from '../infra/storage';
import {
  EXERCISE_GENDER_IMAGE_MIME,
  EXERCISE_GENDER_MEDIA_COLUMNS,
  thumbnailKeyFor,
  videoPreviewKeyFor,
} from '../domain/exerciseGenderMedia';
import { processExerciseImage } from '../domain/exerciseImageProcessing';
import { containedPictureBox } from '../domain/exerciseImageRecrop';

export interface RecropReport {
  exercises: number;
  masters: number;
  recropped: number;
  unchanged: number;
  failed: { key: string; error: string }[];
}

/** The 1080 master keys an exercise row stores media under: each image and each video's preview. */
export function masterKeysOf(row: Record<string, string | null>): string[] {
  const keys: string[] = [];
  for (const gender of ['male', 'female'] as const) {
    const image = storageKeyFromObjectUrl(row[EXERCISE_GENDER_MEDIA_COLUMNS[gender].image]);
    if (image && image.endsWith('.webp')) keys.push(image);
    const video = storageKeyFromObjectUrl(row[EXERCISE_GENDER_MEDIA_COLUMNS[gender].video]);
    if (video && video.endsWith('.mp4')) keys.push(videoPreviewKeyFor(video));
  }
  return keys;
}

export async function recropExerciseImages(options: { execute: boolean; log?: (line: string) => void }): Promise<RecropReport> {
  const log = options.log ?? (() => {});
  const report: RecropReport = { exercises: 0, masters: 0, recropped: 0, unchanged: 0, failed: [] };
  const columns = (['male', 'female'] as const)
    .flatMap((g) => [EXERCISE_GENDER_MEDIA_COLUMNS[g].image, EXERCISE_GENDER_MEDIA_COLUMNS[g].video]);
  const { rows } = await db.query<Record<string, string | null>>(
    `SELECT id, ${columns.join(', ')} FROM exercises WHERE ${columns.map((c) => `${c} IS NOT NULL`).join(' OR ')}`,
  );
  report.exercises = rows.length;

  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of masterKeysOf(row)) {
      if (seen.has(key)) continue; // a copied reference shares its objects
      seen.add(key);
      report.masters += 1;
      try {
        const { body } = await getStorageObject(key);
        const { data, info } = await sharp(body).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        const box = containedPictureBox(data, info.width, info.height);
        if (!box) {
          report.unchanged += 1;
          continue;
        }
        if (!options.execute) {
          report.recropped += 1;
          log(`would re-crop ${key} (picture ${box.width}×${box.height})`);
          continue;
        }
        const picture = await sharp(body).extract(box).png().toBuffer();
        const processed = await processExerciseImage(picture, { fit: 'cover' });
        if ('rejection' in processed) throw new Error(processed.rejection);
        await uploadStorageObject(key, EXERCISE_GENDER_IMAGE_MIME, processed.image);
        await uploadStorageObject(thumbnailKeyFor(key), EXERCISE_GENDER_IMAGE_MIME, processed.thumbnail);
        report.recropped += 1;
        log(`re-cropped ${key}`);
      } catch (err: any) {
        report.failed.push({ key, error: String(err?.message ?? err) });
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
  const report = await recropExerciseImages({ execute, log: (line) => console.log(line) });
  console.log(
    `${execute ? 'Re-cropped' : 'Dry run —'} ${report.exercises} exercises, ${report.masters} masters, ` +
    `${report.recropped} ${execute ? 're-cropped' : 'to re-crop'}, ${report.unchanged} unchanged, ${report.failed.length} failed.`,
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
