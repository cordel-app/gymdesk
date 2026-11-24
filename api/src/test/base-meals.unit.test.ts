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

  it('seeds a meal for every fixed meal_type the nutrition-plan routers accept', () => {
    const router = readFileSync(join(__dirname, '..', 'api', 'nutrition-plan-templates.ts'), 'utf-8');
    const list = router.match(/const MEAL_TYPES = \[([\s\S]*?)\] as const/)![1];
    const types = [...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(SYSTEM_BASE_MEALS.map((m) => m.slug).sort()).toEqual(types.sort());
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
