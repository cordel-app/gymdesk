// What a **re-import** does to a Gym Exercise's media references (#719 §12,
// part 3).
//
// Importing a Base Exercise copies its media *references* into the gym's copy
// (§2) — since #1420 the four gender-specific masters — and from that moment the
// copy owns them (§3's snapshot rule): the Base
// Exercise's later edits never reach it, and there is no runtime fallback in
// either direction. §12 makes **re-importing** the one supported way back to the
// System media — there is deliberately no separate "restore System media"
// action — so `POST /exercises/import` has to do something for an exercise the
// gym already has, where #718 only ever reported it as `skipped`.
//
// This module is that decision, and nothing else: pure, so the SQL flag the
// Import modal reads (`media_refreshable`) and the UPDATE the route performs are
// derived from one rule and can be unit-tested without a database or a bucket.

/**
 * The four gender-specific media masters of an `exercises` row — a Base
 * Exercise's or a gym's copy's. A master's thumbnail or preview is derived from
 * its URL (`domain/exerciseGenderMedia.ts`), so a reference covers its companions.
 */
export interface ExerciseMediaRefs {
  image_male_url: string | null;
  image_female_url: string | null;
  video_male_url: string | null;
  video_female_url: string | null;
}

/**
 * The four columns, in a fixed order. A writer builds its `SET` list from this
 * tuple rather than from `Object.keys(plan.changes)`, so the column names in the
 * SQL are literals of this module and can never come from anywhere else.
 */
export const EXERCISE_MEDIA_COLUMNS = [
  'image_male_url',
  'image_female_url',
  'video_male_url',
  'video_female_url',
] as const;

export interface ExerciseMediaRefreshPlan {
  /** The columns to write — only the masters the Base Exercise actually has. */
  changes: Partial<ExerciseMediaRefs>;
  /**
   * The masters the copy stops pointing at. Candidates for deletion only: the
   * route still asks `isGymOwnedImageUrl()` whether each one is this gym's own
   * object and whether another exercise still references it (§19).
   */
  stale: string[];
  /** Whether an image master is being restored from the Base Exercise. */
  image: boolean;
  /** Whether a video master is being restored from the Base Exercise. */
  video: boolean;
}

/** NULL-safe equality, so "both absent" counts as unchanged rather than as a change. */
function same(a: string | null, b: string | null): boolean {
  return (a ?? null) === (b ?? null);
}

/**
 * What re-importing `base` into an existing `copy` should change, or `null` when
 * the copy already carries the Base Exercise's current media.
 *
 * Two rules decide this, and both matter:
 *
 *  - **The four masters move independently.** A male image, a female image, a
 *    male video and a female video are four different objects; a Base Exercise
 *    that has the male image but no female one restores the male image and says
 *    nothing about the female.
 *  - **A master the Base Exercise does not have restores nothing.** Re-import
 *    exists to *obtain* the System media (§12), so a base row with no
 *    `image_male_url` leaves the gym's own uploaded male image exactly where it
 *    is rather than clearing it — clearing it would make a routine re-import
 *    delete work the gym did, which §8/§23's "never destroy valid media" rule is
 *    there to prevent. Removing a gym image on purpose is
 *    `DELETE /exercises/:id/image/:gender`.
 *
 * Nothing here touches `cloned_from_id`, the name, the description or the
 * defaults. Provenance is what the badge reads (#718), and a gym may have edited
 * its copy — a re-import restores media, not the whole row.
 */
export function planExerciseMediaRefresh(
  base: ExerciseMediaRefs,
  copy: ExerciseMediaRefs,
): ExerciseMediaRefreshPlan | null {
  const changes: Partial<ExerciseMediaRefs> = {};
  const stale: string[] = [];
  let image = false;
  let video = false;

  for (const column of EXERCISE_MEDIA_COLUMNS) {
    const next = base[column];
    if (!next || same(next, copy[column])) continue;
    changes[column] = next;
    if (copy[column]) stale.push(copy[column] as string);
    if (column.startsWith('image_')) image = true;
    else video = true;
  }

  if (!image && !video) return null;

  const kept = new Set(Object.values(changes).filter((v): v is string => !!v));
  return { changes, stale: stale.filter((url) => !kept.has(url)), image, video };
}

/**
 * The masters a re-import keeps pointing at once `plan` is applied — what
 * `deleteReplacedExerciseMedia()` must *not* delete, including the ones the plan
 * left alone.
 */
export function mediaRefsAfterRefresh(copy: ExerciseMediaRefs, plan: ExerciseMediaRefreshPlan): ExerciseMediaRefs {
  return { ...copy, ...plan.changes };
}
