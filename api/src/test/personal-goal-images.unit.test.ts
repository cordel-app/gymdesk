// #1722 — a Personal Goal's image is the shared WebP pipeline's: where it goes,
// which objects each side may delete, and which kinds carry the pair.

import { describe, expect, it } from 'vitest';
import {
  GOAL_IMAGE_FOLDERS,
  buildNutritionGoalImageKey,
  buildNutritionGoalImageThumbnailKey,
  isOwnedNutritionGoalImageUrl,
  nutritionGoalImageFolderKeys,
} from '../domain/nutritionGoalImages';
import { GOAL_LIBRARY_KINDS, WEBP_IMAGE_GOAL_KINDS, goalKindHasWebpImage } from '../domain/goalLibrary';

const goals = GOAL_IMAGE_FOLDERS.personal;

describe('personal goal image keys', () => {
  it('keeps the goals/ folder and now names a WebP master and a -thumbnail sibling', () => {
    expect(goals).toBe('goals');
    expect(buildNutritionGoalImageKey('gyms/7-Fit', 12, 'Weight Loss', goals)).toBe('gyms/7-Fit/goals/12-Weight-Loss.webp');
    expect(buildNutritionGoalImageThumbnailKey('gyms/7-Fit', 12, 'Weight Loss', goals))
      .toBe('gyms/7-Fit/goals/12-Weight-Loss-thumbnail.webp');
    expect(buildNutritionGoalImageKey('cordel', 3, 'Energy', goals)).toBe('cordel/goals/3-Energy.webp');
  });

  it('lists the markers from the root down to goals/', () => {
    expect(nutritionGoalImageFolderKeys('cordel', goals)).toEqual(['cordel/', 'cordel/goals/']);
  });

  it('keeps Nutrition Goals in nutrition_goals/ by default', () => {
    expect(buildNutritionGoalImageKey('cordel', 3, 'Water')).toBe('cordel/nutrition_goals/3-Water.webp');
    expect(GOAL_IMAGE_FOLDERS.nutrition).toBe('nutrition_goals');
  });
});

describe('isOwnedNutritionGoalImageUrl for the goals/ folder', () => {
  process.env.CLOUDFLARE_R2_ENDPOINT = 'https://example.r2.cloudflarestorage.com';
  process.env.CLOUDFLARE_R2_BUCKET = 'test-bucket';
  const base = 'https://example.r2.cloudflarestorage.com/test-bucket';

  it("is true for the owner's own goals/ objects — a legacy PNG included — and false for anything else", () => {
    const prefix = 'gyms/7-Fit';
    expect(isOwnedNutritionGoalImageUrl(`${base}/${prefix}/goals/1-x.png`, prefix, goals)).toBe(true);
    expect(isOwnedNutritionGoalImageUrl(`${base}/${prefix}/goals/1-x.webp`, prefix, goals)).toBe(true);
    expect(isOwnedNutritionGoalImageUrl(`${base}/${prefix}/nutrition_goals/1-x.webp`, prefix, goals)).toBe(false);
    expect(isOwnedNutritionGoalImageUrl(`${base}/cordel/goals/1-x.webp`, prefix, goals)).toBe(false);
    expect(isOwnedNutritionGoalImageUrl(`${base}/gyms/8-Other/goals/1-x.webp`, prefix, goals)).toBe(false);
    expect(isOwnedNutritionGoalImageUrl('https://example.com/x.png', prefix, goals)).toBe(false);
  });
});

describe('which goal kinds carry the WebP pair', () => {
  it('is every kind, and there is no second image declaration', () => {
    expect([...WEBP_IMAGE_GOAL_KINDS].sort()).toEqual([...GOAL_LIBRARY_KINDS].sort());
    for (const kind of GOAL_LIBRARY_KINDS) expect(goalKindHasWebpImage(kind)).toBe(true);
  });
});
