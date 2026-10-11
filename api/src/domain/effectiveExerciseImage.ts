/**
 * #1368 stage 4 — the image an exercise is shown with.
 *
 * An exercise's own image (`image_url` / `image_thumbnail_url`) wins; when it has
 * none, the image of its primary muscle stands in. Nothing is stored: the muscle
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
}

export interface EffectiveImage {
  effective_image_url: string | null;
  effective_image_thumbnail_url: string | null;
}

/** The principal muscles of exercise alias `alias` that have an image. */
export const primaryMuscleImagesSql = (alias = 'e') => `
    (SELECT JSON_ARRAYAGG(JSON_OBJECT('id', pm.id, 'name', pm.name,
                                      'image_url', COALESCE(pm.image_male_url, pm.image_female_url),
                                      'image_thumbnail_url', IF(pm.image_male_url IS NOT NULL, pm.image_male_url_thumbnail, pm.image_female_url_thumbnail)))
     FROM exercise_muscles pem
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
  own: { image_url?: string | null; image_thumbnail_url?: string | null },
  muscles: unknown,
): EffectiveImage {
  if (own.image_url) {
    return { effective_image_url: own.image_url, effective_image_thumbnail_url: own.image_thumbnail_url ?? null };
  }
  const sorted = asCandidates(muscles).sort((a, b) => {
    const byName = String(a.name).toLowerCase().localeCompare(String(b.name).toLowerCase());
    return byName !== 0 ? byName : Number(a.id) - Number(b.id);
  });
  const first = sorted[0];
  return {
    effective_image_url: first?.image_url ?? null,
    effective_image_thumbnail_url: first?.image_thumbnail_url ?? null,
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
const primaryMuscleImageSql = (alias: string, column: 'image_url' | 'image_thumbnail_url') =>
  `(SELECT ${column === 'image_url'
      ? 'COALESCE(pm.image_male_url, pm.image_female_url)'
      : 'IF(pm.image_male_url IS NOT NULL, pm.image_male_url_thumbnail, pm.image_female_url_thumbnail)'} FROM exercise_muscles pem JOIN muscles pm ON pm.id = pem.muscle_id
     WHERE pem.exercise_id = ${alias}.id AND pem.role = 'principal' AND COALESCE(pm.image_male_url, pm.image_female_url) IS NOT NULL
     ORDER BY LOWER(pm.name), pm.id LIMIT 1)`;

export const effectiveImageUrlSql = (alias = 'e') =>
  `COALESCE(${alias}.image_url, ${primaryMuscleImageSql(alias, 'image_url')})`;

export const effectiveImageThumbnailUrlSql = (alias = 'e') =>
  `IF(${alias}.image_url IS NULL, ${primaryMuscleImageSql(alias, 'image_thumbnail_url')}, ${alias}.image_thumbnail_url)`;
