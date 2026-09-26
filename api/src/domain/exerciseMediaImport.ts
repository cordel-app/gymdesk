// What a **re-import** does to a Gym Exercise's media references (#719 §12,
// part 3).
//
// Importing a Base Exercise copies its media *references* into the gym's copy
// (§2), and from that moment the copy owns them (§3's snapshot rule): the Base
// Exercise's later edits never reach it, and there is no runtime fallback in
// either direction. §12 makes **re-importing** the one supported way back to the
// System media — there is deliberately no separate "restore System media"
// action — so `POST /exercises/import` has to do something for an exercise the
// gym already has, where #718 only ever reported it as `skipped`.
//
// This module is that decision, and nothing else: pure, so the SQL flag the
// Import modal reads (`media_refreshable`) and the UPDATE the route performs are
// derived from one rule and can be unit-tested without a database or a bucket.

/** The four media columns of an `exercises` row — a Base Exercise's or a gym's copy's. */
export interface ExerciseMediaRefs {
  image_url: string | null;
  image_thumbnail_url: string | null;
  video_url: string | null;
  video_thumbnail_url: string | null;
}

/**
 * The four columns, in a fixed order. A writer builds its `SET` list from this
 * tuple rather than from `Object.keys(plan.changes)`, so the column names in the
 * SQL are literals of this module and can never come from anywhere else.
 */
export const EXERCISE_MEDIA_COLUMNS = [
  'image_url',
  'image_thumbnail_url',
  'video_url',
  'video_thumbnail_url',
] as const;

export interface ExerciseMediaRefreshPlan {
  /** The columns to write — only the pairs the Base Exercise actually has. */
  changes: Partial<ExerciseMediaRefs>;
  /**
   * What the copy stops pointing at. Candidates for deletion only: the route
   * still asks `isGymOwnedImageUrl()` whether each one is this gym's own object
   * and whether another exercise still references it (§19).
   */
  stale: string[];
  /** Whether the image pair is being restored from the Base Exercise. */
  image: boolean;
  /** Whether the video pair is being restored from the Base Exercise. */
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
 *  - **The image pair and the video pair move independently.** They are two
 *    different objects with two different owners' histories; a Base Exercise
 *    that has artwork but no clip restores the artwork and says nothing about
 *    the clip.
 *  - **A pair the Base Exercise does not have restores nothing.** Re-import
 *    exists to *obtain* the System media (§12), so a base row with no
 *    `image_url` leaves the gym's own uploaded image exactly where it is rather
 *    than clearing it — clearing it would make a routine re-import delete work
 *    the gym did, which §8/§23's "never destroy valid media" rule is there to
 *    prevent. Removing a gym image on purpose is `DELETE /exercises/:id/image`,
 *    and it deliberately leaves the exercise with no image at all (§10).
 *
 * A thumbnail always travels with the media it depicts: restoring an image
 * writes the Base Exercise's `image_thumbnail_url` too, even when that is NULL
 * (a System master stored without a thumbnail), because the gym's old thumbnail
 * belonged to the master it replaced.
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

  if (base.image_url && !(same(base.image_url, copy.image_url) && same(base.image_thumbnail_url, copy.image_thumbnail_url))) {
    image = true;
    changes.image_url = base.image_url;
    changes.image_thumbnail_url = base.image_thumbnail_url ?? null;
    stale.push(copy.image_url ?? '', copy.image_thumbnail_url ?? '');
  }

  if (base.video_url && !(same(base.video_url, copy.video_url) && same(base.video_thumbnail_url, copy.video_thumbnail_url))) {
    video = true;
    changes.video_url = base.video_url;
    changes.video_thumbnail_url = base.video_thumbnail_url ?? null;
    stale.push(copy.video_url ?? '', copy.video_thumbnail_url ?? '');
  }

  if (!image && !video) return null;

  const kept = new Set(Object.values(changes).filter((v): v is string => !!v));
  return {
    changes,
    stale: stale.filter((url) => url !== '' && !kept.has(url)),
    image,
    video,
  };
}

/**
 * The columns a re-import keeps pointing at once `plan` is applied — what
 * `deleteReplacedExerciseMedia()` must *not* delete, including the pair the plan
 * left alone.
 */
export function mediaRefsAfterRefresh(copy: ExerciseMediaRefs, plan: ExerciseMediaRefreshPlan): ExerciseMediaRefs {
  return { ...copy, ...plan.changes };
}
