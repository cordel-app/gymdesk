import { imageThumbnailUrlFor } from './exerciseGenderMedia';
import { ExerciseTables, LEGACY_EXERCISE_TABLES } from './exerciseTables';

/**
 * #1368 stage 4 — the image an exercise is shown with.
 *
 * An exercise's own image wins — since #1420 its male image, then its female one,
 * because there is no sex context here (the convention #1412 set for a muscle) —
 * and when it has none, the image of its primary muscle stands in. Nothing is stored: the muscle
 * image is read at query time (`PRIMARY_MUSCLE_IMAGES_SQL`) and this module is the
 * one place that decides precedence, so the raw fields stay the exercise's own
 * media (what the media editors upload and delete) and a muscle image is never
 * written onto, or deleted through, an exercise.
 *
 * Among several primary muscles that carry an image, the alphabetically first
 * name wins (case-folded), with the muscle id as the tie-break.
 */

export interface MuscleImageCandidate {
  id: number;
  name: string;
  image_url: string | null;
  image_thumbnail_url: string | null;
  image_male_thumbnail_url?: string | null;
  image_female_thumbnail_url?: string | null;
}

export interface EffectiveImage {
  effective_image_url: string | null;
  effective_image_thumbnail_url: string | null;
  /** #1704: the thumbnail shown in the male / female position, each falling back on its own to the primary muscle's image of that sex. */
  effective_image_male_thumbnail_url: string | null;
  effective_image_female_thumbnail_url: string | null;
}

/** The principal muscles of exercise alias `alias` that have an image. */
export const primaryMuscleImagesSql = (alias = 'e', tables: ExerciseTables = LEGACY_EXERCISE_TABLES) => `
    (SELECT JSON_ARRAYAGG(JSON_OBJECT('id', pm.id, 'name', pm.name,
                                      'image_url', COALESCE(pm.image_male_url, pm.image_female_url),
                                      'image_thumbnail_url', IF(pm.image_male_url IS NOT NULL, pm.image_male_url_thumbnail, pm.image_female_url_thumbnail),
                                      'image_male_thumbnail_url', pm.image_male_url_thumbnail,
                                      'image_female_thumbnail_url', pm.image_female_url_thumbnail))
     FROM ${tables.muscles} pem
     JOIN muscles pm ON pm.id = pem.muscle_id
     WHERE pem.exercise_id = ${alias}.id AND pem.role = 'principal' AND COALESCE(pm.image_male_url, pm.image_female_url) IS NOT NULL) AS primary_muscle_images`;

function asCandidates(value: unknown): MuscleImageCandidate[] {
  let v = value;
  if (typeof v === 'string') {
    try { v = JSON.parse(v); } catch { return []; }
  }
  return Array.isArray(v) ? (v as MuscleImageCandidate[]).filter((m) => m && m.image_url) : [];
}

export function resolveEffectiveImage(
  own: { image_male_url?: string | null; image_female_url?: string | null },
  muscles: unknown,
): EffectiveImage {
  const sorted = asCandidates(muscles).sort((a, b) => {
    const byName = String(a.name).toLowerCase().localeCompare(String(b.name).toLowerCase());
    return byName !== 0 ? byName : Number(a.id) - Number(b.id);
  });
  // #1704: each position falls back independently, to the first primary muscle carrying that sex's image.
  const male = own.image_male_url ? imageThumbnailUrlFor(own.image_male_url)
    : sorted.find((m) => m.image_male_thumbnail_url)?.image_male_thumbnail_url ?? null;
  const female = own.image_female_url ? imageThumbnailUrlFor(own.image_female_url)
    : sorted.find((m) => m.image_female_thumbnail_url)?.image_female_thumbnail_url ?? null;
  const genders = { effective_image_male_thumbnail_url: male, effective_image_female_thumbnail_url: female };
  const ownUrl = own.image_male_url || own.image_female_url || null;
  if (ownUrl) {
    return { effective_image_url: ownUrl, effective_image_thumbnail_url: imageThumbnailUrlFor(ownUrl), ...genders };
  }
  const first = sorted[0];
  return {
    effective_image_url: first?.image_url ?? null,
    effective_image_thumbnail_url: first?.image_thumbnail_url ?? null,
    ...genders,
  };
}

/** Adds the effective fields and drops the helper column from an exercise row. */
export function withEffectiveImage<T extends Record<string, any>>(row: T): Omit<T, 'primary_muscle_images'> & EffectiveImage {
  const { primary_muscle_images, ...rest } = row;
  return { ...rest, ...resolveEffectiveImage(row, primary_muscle_images) };
}

/**
 * SQL spelling of the same precedence for the read paths that project an
 * exercise's media inline (training plans, workout templates). The ordering is
 * the resolver's: case-folded name, then id. `resolveEffectiveImage()` is the
 * reference; `effective-exercise-image.unit.test.ts` pins both.
 */
// #1412: with no sex context the male image stands in, then the female one.
// #1540: a Members App read passes the member's sex and the order flips for 'female'.
export type ImageSex = 'male' | 'female';

/** The member-profile gender (`members.gender`) as the sex an exercise image is chosen for; anything but Woman reads as male (the no-context default). */
export function imageSexForGender(gender: string | null | undefined): ImageSex {
  return gender === 'Woman' ? 'female' : 'male';
}

const first = (alias: string, sex: ImageSex) =>
  sex === 'female' ? [`${alias}.image_female_url`, `${alias}.image_male_url`] : [`${alias}.image_male_url`, `${alias}.image_female_url`];

const primaryMuscleImageSql = (alias: string, column: 'image_url' | 'image_thumbnail_url', sex: ImageSex = 'male') => {
  const [m, o] = sex === 'female' ? ['female', 'male'] : ['male', 'female'];
  return `(SELECT ${column === 'image_url'
      ? `COALESCE(pm.image_${m}_url, pm.image_${o}_url)`
      : `IF(pm.image_${m}_url IS NOT NULL, pm.image_${m}_url_thumbnail, pm.image_${o}_url_thumbnail)`} FROM exercise_muscle_catalogue pem JOIN muscles pm ON pm.id = pem.muscle_id
     WHERE pem.exercise_id = ${alias}.id AND pem.role = 'principal' AND COALESCE(pm.image_male_url, pm.image_female_url) IS NOT NULL
     ORDER BY LOWER(pm.name), pm.id LIMIT 1)`;
};

export const effectiveImageUrlSql = (alias = 'e', sex: ImageSex = 'male') =>
  `COALESCE(${first(alias, sex).join(', ')}, ${primaryMuscleImageSql(alias, 'image_url', sex)})`;

/**
 * `<name>.<ext>` → `<name>-thumbnail.webp` for the SQL expression `url`, NULL when
 * the URL does not end in `.<ext>` (an external link has no derived companion).
 */
const derivedCompanionSql = (url: string, ext: 'webp' | 'mp4') =>
  `IF(${url} LIKE '%.${ext}', CONCAT(LEFT(${url}, CHAR_LENGTH(${url}) - ${ext.length + 1}), '-thumbnail.webp'), NULL)`;

/** An exercise's own thumbnail is derived from its master URL: `<name>.webp` → `<name>-thumbnail.webp`. */
export const effectiveImageThumbnailUrlSql = (alias = 'e', sex: ImageSex = 'male') => {
  const own = `COALESCE(${first(alias, sex).join(', ')})`;
  return `IF(${own} IS NULL,
      ${primaryMuscleImageSql(alias, 'image_thumbnail_url', sex)},
      ${derivedCompanionSql(own, 'webp')})`;
};

/** The video an exercise is shown with: the male one, else the female one (no sex context, #1412's convention). */
// #1527: a Members App read passes the member's sex and the order flips for 'female'; a single video plays whatever the sex.
export const effectiveVideoUrlSql = (alias = 'e', sex: ImageSex = 'male') =>
  sex === 'female' ? `COALESCE(${alias}.video_female_url, ${alias}.video_male_url)` : `COALESCE(${alias}.video_male_url, ${alias}.video_female_url)`;

/** That video's 256x256 preview thumbnail, derived from its URL: `<name>.mp4` → `<name>-thumbnail.webp`. */
export const effectiveVideoPosterSql = (alias = 'e', sex: ImageSex = 'male') =>
  derivedCompanionSql(effectiveVideoUrlSql(alias, sex), 'mp4');
