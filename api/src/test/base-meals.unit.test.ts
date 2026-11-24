// #3328 stage 1: the Base Meals' seed and image keys.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SYSTEM_BASE_MEALS,
  buildBaseMealImageKey,
  buildBaseMealImageThumbnailKey,
  isOwnedBaseMealImageUrl,
} from '../domain/baseMeals';

describe('Base Meals (#3328)', () => {
  it('the domain seed mirrors migration 478', () => {
    const migration = require(join(__dirname, '..', 'infra', 'migrations', '478_base_meals.js'));
    const source = readFileSync(join(__dirname, '..', 'infra', 'migrations', '478_base_meals.js'), 'utf-8');
    expect(typeof migration.up).toBe('function');
    for (const meal of SYSTEM_BASE_MEALS) {
      expect(source).toContain(`slug: '${meal.slug}'`);
      expect(source).toContain(meal.en);
    }
    expect((source.match(/slug: '/g) ?? []).length).toBe(SYSTEM_BASE_MEALS.length);
  });

  it('seeds a meal for every value the closed meal_type CHECK used to accept, so 479 backfills them all', () => {
    const source = readFileSync(join(__dirname, '..', 'infra', 'migrations', '143_nutrition_training_meal_types.js'), 'utf-8');
    const list = source.match(/const MEAL_TYPES_WITH_TRAINING = \[([\s\S]*?)\];/)![1];
    const types = [...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(SYSTEM_BASE_MEALS.map((m) => m.slug).sort()).toEqual(types.sort());
  });

  it('no nutrition-plan router keeps a fixed meal list any more (#3328 stage 2)', () => {
    for (const file of ['nutrition-plan-templates.ts', 'platform-nutrition-plan-templates.ts', 'member-nutrition-plans.ts']) {
      const router = readFileSync(join(__dirname, '..', 'api', file), 'utf-8');
      expect(router).not.toMatch(/const MEAL_TYPES\b/);
      expect(router).toContain('resolveBaseMealInput');
    }
  });

  it('keys the image by id and slug under cordel/meals/', () => {
    expect(buildBaseMealImageKey(7, 'breakfast')).toBe('cordel/meals/7-breakfast.webp');
    expect(buildBaseMealImageThumbnailKey(7, 'post-workout')).toBe('cordel/meals/7-post-workout-thumbnail.webp');
    expect(buildBaseMealImageKey(3, 'media_manana')).toBe('cordel/meals/3-media_manana.webp');
  });

  it('only an object under cordel/meals/ may be swept', () => {
    expect(isOwnedBaseMealImageUrl(null)).toBe(false);
    expect(isOwnedBaseMealImageUrl('https://example.com/x.webp')).toBe(false);
  });
});
