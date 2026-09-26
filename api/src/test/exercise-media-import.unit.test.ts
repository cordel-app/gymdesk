// #719 part 3 (§12) — what a **re-import** does to a Gym Exercise's media
// references. Pure: no DB, no bucket, no HTTP (see CLAUDE.md's unit-vs-
// integration rule). The route's behaviour and the `media_refreshable` flag the
// Import modal reads are both derived from this rule, so this is where the rule
// itself is pinned.

import { describe, expect, it } from 'vitest';
import {
  ExerciseMediaRefs,
  mediaRefsAfterRefresh,
  planExerciseMediaRefresh,
} from '../domain/exerciseMediaImport';

const SYSTEM_IMAGE = 'https://r2.example.com/bucket/cordel/Exercises/Images/12-Barbell-Press.png';
const SYSTEM_THUMB = 'https://r2.example.com/bucket/cordel/Exercises/Images/12-Barbell-Press-thumbnail.png';
const SYSTEM_VIDEO = 'https://r2.example.com/bucket/cordel/Exercises/Videos/12-Barbell-Press.mp4';
const SYSTEM_POSTER = 'https://r2.example.com/bucket/cordel/Exercises/Videos/12-Barbell-Press-thumbnail.png';
const GYM_IMAGE = 'https://r2.example.com/bucket/gyms/g1-Fit/Exercises/Images/44-Barbell-Press.png';
const GYM_THUMB = 'https://r2.example.com/bucket/gyms/g1-Fit/Exercises/Images/44-Barbell-Press-thumbnail.png';
const GYM_VIDEO = 'https://r2.example.com/bucket/gyms/g1-Fit/Exercises/Videos/44-Barbell-Press.mp4';
const GYM_POSTER = 'https://r2.example.com/bucket/gyms/g1-Fit/Exercises/Videos/44-Barbell-Press-thumbnail.png';

const NONE: ExerciseMediaRefs = {
  image_url: null, image_thumbnail_url: null, video_url: null, video_thumbnail_url: null,
};

const refs = (over: Partial<ExerciseMediaRefs>): ExerciseMediaRefs => ({ ...NONE, ...over });

describe('planExerciseMediaRefresh', () => {
  it('is a no-op when the copy already carries the Base Exercise’s media', () => {
    const base = refs({
      image_url: SYSTEM_IMAGE, image_thumbnail_url: SYSTEM_THUMB,
      video_url: SYSTEM_VIDEO, video_thumbnail_url: SYSTEM_POSTER,
    });
    expect(planExerciseMediaRefresh(base, { ...base })).toBeNull();
  });

  it('is a no-op when neither side has any media', () => {
    expect(planExerciseMediaRefresh(NONE, NONE)).toBeNull();
  });

  it('restores an image pair the gym replaced with its own upload', () => {
    const base = refs({ image_url: SYSTEM_IMAGE, image_thumbnail_url: SYSTEM_THUMB });
    const copy = refs({ image_url: GYM_IMAGE, image_thumbnail_url: GYM_THUMB });
    const plan = planExerciseMediaRefresh(base, copy)!;
    expect(plan.image).toBe(true);
    expect(plan.video).toBe(false);
    expect(plan.changes).toEqual({ image_url: SYSTEM_IMAGE, image_thumbnail_url: SYSTEM_THUMB });
    // The gym's own objects are what the route may then delete (§19).
    expect(plan.stale.sort()).toEqual([GYM_IMAGE, GYM_THUMB].sort());
  });

  it('restores a video pair the gym replaced, including its poster', () => {
    const base = refs({ video_url: SYSTEM_VIDEO, video_thumbnail_url: SYSTEM_POSTER });
    const copy = refs({ video_url: GYM_VIDEO, video_thumbnail_url: GYM_POSTER });
    const plan = planExerciseMediaRefresh(base, copy)!;
    expect(plan.video).toBe(true);
    expect(plan.image).toBe(false);
    expect(plan.changes).toEqual({ video_url: SYSTEM_VIDEO, video_thumbnail_url: SYSTEM_POSTER });
    expect(plan.stale.sort()).toEqual([GYM_POSTER, GYM_VIDEO].sort());
  });

  it('moves the two pairs independently — a System image restores without touching the gym’s video', () => {
    const base = refs({ image_url: SYSTEM_IMAGE, image_thumbnail_url: SYSTEM_THUMB });
    const copy = refs({
      image_url: GYM_IMAGE, image_thumbnail_url: GYM_THUMB,
      video_url: GYM_VIDEO, video_thumbnail_url: GYM_POSTER,
    });
    const plan = planExerciseMediaRefresh(base, copy)!;
    expect(plan.changes).not.toHaveProperty('video_url');
    expect(plan.changes).not.toHaveProperty('video_thumbnail_url');
    expect(plan.stale).not.toContain(GYM_VIDEO);
    expect(plan.stale).not.toContain(GYM_POSTER);
    expect(mediaRefsAfterRefresh(copy, plan)).toEqual(refs({
      image_url: SYSTEM_IMAGE, image_thumbnail_url: SYSTEM_THUMB,
      video_url: GYM_VIDEO, video_thumbnail_url: GYM_POSTER,
    }));
  });

  it('never clears a pair the Base Exercise does not have — re-import restores, it does not remove', () => {
    // A base row with no media has nothing to restore: the gym's own upload
    // survives untouched (§8/§23 — a routine re-import destroys no valid media).
    const copy = refs({
      image_url: GYM_IMAGE, image_thumbnail_url: GYM_THUMB,
      video_url: GYM_VIDEO, video_thumbnail_url: GYM_POSTER,
    });
    expect(planExerciseMediaRefresh(NONE, copy)).toBeNull();
    // …and with only a System video to give, the gym's image stays.
    const plan = planExerciseMediaRefresh(refs({ video_url: SYSTEM_VIDEO }), copy)!;
    expect(plan.image).toBe(false);
    expect(plan.changes).toEqual({ video_url: SYSTEM_VIDEO, video_thumbnail_url: null });
    expect(plan.stale.sort()).toEqual([GYM_POSTER, GYM_VIDEO].sort());
  });

  it('fills an empty copy from the Base Exercise, with nothing to clean up', () => {
    const base = refs({
      image_url: SYSTEM_IMAGE, image_thumbnail_url: SYSTEM_THUMB,
      video_url: SYSTEM_VIDEO, video_thumbnail_url: SYSTEM_POSTER,
    });
    const plan = planExerciseMediaRefresh(base, NONE)!;
    expect(plan.image).toBe(true);
    expect(plan.video).toBe(true);
    expect(plan.stale).toEqual([]);
    expect(mediaRefsAfterRefresh(NONE, plan)).toEqual(base);
  });

  it('writes a NULL companion when the System master has no thumbnail', () => {
    // A thumbnail always travels with the media it depicts: the gym's old
    // thumbnail belonged to the master it replaced, so it goes either way.
    const plan = planExerciseMediaRefresh(
      refs({ image_url: SYSTEM_IMAGE }),
      refs({ image_url: GYM_IMAGE, image_thumbnail_url: GYM_THUMB }),
    )!;
    expect(plan.changes).toEqual({ image_url: SYSTEM_IMAGE, image_thumbnail_url: null });
    expect(plan.stale.sort()).toEqual([GYM_IMAGE, GYM_THUMB].sort());
  });

  it('refreshes when only the thumbnail moved', () => {
    const plan = planExerciseMediaRefresh(
      refs({ image_url: SYSTEM_IMAGE, image_thumbnail_url: SYSTEM_THUMB }),
      refs({ image_url: SYSTEM_IMAGE, image_thumbnail_url: null }),
    )!;
    expect(plan.image).toBe(true);
    expect(plan.changes).toEqual({ image_url: SYSTEM_IMAGE, image_thumbnail_url: SYSTEM_THUMB });
    expect(plan.stale).toEqual([]);
  });

  it('keeps an object the refreshed pair still points at out of the stale list', () => {
    // The master is unchanged and only the thumbnail moved on: deleting the
    // master because it appeared in the old pair would break the row itself.
    const plan = planExerciseMediaRefresh(
      refs({ image_url: SYSTEM_IMAGE, image_thumbnail_url: SYSTEM_THUMB }),
      refs({ image_url: SYSTEM_IMAGE, image_thumbnail_url: GYM_THUMB }),
    )!;
    expect(plan.stale).toEqual([GYM_THUMB]);
  });

  it('treats an external link as any other reference', () => {
    const plan = planExerciseMediaRefresh(
      refs({ video_url: SYSTEM_VIDEO, video_thumbnail_url: SYSTEM_POSTER }),
      refs({ video_url: 'https://youtu.be/abc123', video_thumbnail_url: null }),
    )!;
    expect(plan.video).toBe(true);
    // Listed as stale, but the route's ownership test refuses to delete it.
    expect(plan.stale).toEqual(['https://youtu.be/abc123']);
  });

  it('keeps both pairs when one object is referenced through several columns', () => {
    const plan = planExerciseMediaRefresh(
      refs({ image_url: SYSTEM_IMAGE, video_url: SYSTEM_VIDEO }),
      refs({
        image_url: GYM_IMAGE, image_thumbnail_url: GYM_IMAGE,
        video_url: GYM_VIDEO, video_thumbnail_url: GYM_VIDEO,
      }),
    )!;
    // Repeats are harmless — deleteReplacedExerciseMedia() dedupes and asks
    // whether anything still references the object — but the plan must not drop
    // one of the two pairs because the other mentioned the same URL.
    expect(plan.image && plan.video).toBe(true);
    expect(new Set(plan.stale)).toEqual(new Set([GYM_IMAGE, GYM_VIDEO]));
  });
});
