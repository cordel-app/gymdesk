// What re-importing a Base Exercise does to a gym copy's media (#719 §12,
// reshaped by #1420): the four gender-specific masters move independently, a
// master the Base Exercise does not have restores nothing, and nothing else of
// the copy is touched.

import { describe, expect, it } from 'vitest';
import {
  EXERCISE_MEDIA_COLUMNS,
  mediaRefsAfterRefresh,
  planExerciseMediaRefresh,
  type ExerciseMediaRefs,
} from '../domain/exerciseMediaImport';

const SYS = 'https://r2.example.com/bucket/cordel/exercises';
const GYM = 'https://r2.example.com/bucket/gyms/g1-Fit/exercises';

const SYS_IMAGE_M = `${SYS}/images/12-Press-male.webp`;
const SYS_IMAGE_F = `${SYS}/images/12-Press-female.webp`;
const SYS_VIDEO_M = `${SYS}/videos/12-Press-male.mp4`;
const GYM_IMAGE_M = `${GYM}/images/44-Press-male.webp`;
const GYM_VIDEO_M = `${GYM}/videos/44-Press-male.mp4`;

const refs = (over: Partial<ExerciseMediaRefs> = {}): ExerciseMediaRefs => ({
  image_male_url: null, image_female_url: null, video_male_url: null, video_female_url: null, ...over,
});

describe('planExerciseMediaRefresh', () => {
  it('declares exactly the four masters', () => {
    expect([...EXERCISE_MEDIA_COLUMNS]).toEqual(['image_male_url', 'image_female_url', 'video_male_url', 'video_female_url']);
  });

  it('is null when the copy already carries what the Base Exercise has', () => {
    const base = refs({ image_male_url: SYS_IMAGE_M, video_male_url: SYS_VIDEO_M });
    expect(planExerciseMediaRefresh(base, { ...base })).toBeNull();
  });

  it('is null when the Base Exercise has no media at all', () => {
    expect(planExerciseMediaRefresh(refs(), refs({ image_male_url: GYM_IMAGE_M }))).toBeNull();
  });

  it("restores a master the gym's copy lacks or holds another of", () => {
    const plan = planExerciseMediaRefresh(refs({ image_male_url: SYS_IMAGE_M }), refs({ image_male_url: GYM_IMAGE_M }))!;
    expect(plan.changes).toEqual({ image_male_url: SYS_IMAGE_M });
    expect(plan.image).toBe(true);
    expect(plan.video).toBe(false);
    expect(plan.stale).toEqual([GYM_IMAGE_M]);
  });

  it('moves the four masters independently', () => {
    const plan = planExerciseMediaRefresh(
      refs({ image_male_url: SYS_IMAGE_M, image_female_url: SYS_IMAGE_F }),
      refs({ image_male_url: SYS_IMAGE_M, video_male_url: GYM_VIDEO_M }),
    )!;
    expect(plan.changes).toEqual({ image_female_url: SYS_IMAGE_F });
    // The video the Base Exercise does not have is left exactly as the gym has it.
    expect(plan.changes).not.toHaveProperty('video_male_url');
    expect(plan.stale).toEqual([]);
    expect(plan.video).toBe(false);
  });

  it('never clears a gym upload for a master the Base Exercise lacks', () => {
    const plan = planExerciseMediaRefresh(
      refs({ video_male_url: SYS_VIDEO_M }),
      refs({ image_male_url: GYM_IMAGE_M, video_male_url: GYM_VIDEO_M }),
    )!;
    expect(plan.changes).toEqual({ video_male_url: SYS_VIDEO_M });
    expect(plan.video).toBe(true);
    expect(plan.image).toBe(false);
    expect(plan.stale).toEqual([GYM_VIDEO_M]);
  });

  it('does not list as stale a master the plan keeps pointing at', () => {
    const plan = planExerciseMediaRefresh(
      refs({ image_male_url: SYS_IMAGE_M, image_female_url: SYS_IMAGE_M }),
      refs({ image_male_url: GYM_IMAGE_M, image_female_url: SYS_IMAGE_M }),
    )!;
    expect(plan.stale).toEqual([GYM_IMAGE_M]);
  });
});

describe('mediaRefsAfterRefresh', () => {
  it('keeps the masters the plan left alone', () => {
    const copy = refs({ image_male_url: GYM_IMAGE_M, video_male_url: GYM_VIDEO_M });
    const plan = planExerciseMediaRefresh(refs({ image_male_url: SYS_IMAGE_M }), copy)!;
    expect(mediaRefsAfterRefresh(copy, plan)).toEqual({ ...copy, image_male_url: SYS_IMAGE_M });
  });
});
