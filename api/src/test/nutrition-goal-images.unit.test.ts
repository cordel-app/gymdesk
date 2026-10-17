// #1623 — where a Nutrition Goal's image goes, which objects may be deleted, and
// the translated name/description rules and seeds.

import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PLATFORM_NUTRITION_GOALS_PREFIX,
  buildNutritionGoalImageKey,
  buildNutritionGoalImageThumbnailKey,
  isOwnedNutritionGoalImageUrl,
  nutritionGoalImageFolderKeys,
  sanitizeNutritionGoalImageName,
} from '../domain/nutritionGoalImages';
import {
  SYSTEM_NUTRITION_GOAL_TEXTS,
  SYSTEM_PERSONAL_GOAL_TRANSLATIONS,
  goalTranslationsExpr,
  localizedGoalExprs,
  validateGoalTranslations,
  parseGoalTranslations,
  withGoalTranslations,
} from '../domain/nutritionGoalTranslations';
import { SYSTEM_NUTRITION_GOALS, SYSTEM_PERSONAL_GOALS, buildGoalListWhere, goalKindHasWebpImage, goalKindIsTranslated } from '../domain/goalLibrary';

const migration = require(
  join(__dirname, '..', 'infra', 'migrations', '282_nutrition_goal_images_translations.js'),
);

describe('nutrition goal image keys', () => {
  it('builds <prefix>/nutrition_goals/<id>-<name>.webp and its -thumbnail sibling', () => {
    expect(buildNutritionGoalImageKey('gyms/7-Fit Gym', 12, 'Weight, Loss!'))
      .toBe('gyms/7-Fit Gym/nutrition_goals/12-Weight-Loss.webp');
    expect(buildNutritionGoalImageThumbnailKey('gyms/7-Fit Gym', 12, 'Weight, Loss!'))
      .toBe('gyms/7-Fit Gym/nutrition_goals/12-Weight-Loss-thumbnail.webp');
  });

  it('uses the cordel root for a System goal, and the id keeps equal names apart', () => {
    expect(buildNutritionGoalImageKey(PLATFORM_NUTRITION_GOALS_PREFIX, 3, 'Water')).toBe('cordel/nutrition_goals/3-Water.webp');
    expect(buildNutritionGoalImageKey('cordel', 4, 'Water')).not.toBe(buildNutritionGoalImageKey('cordel', 3, 'Water'));
  });

  it('falls back to a word and caps long names', () => {
    expect(sanitizeNutritionGoalImageName('!!!')).toBe('goal');
    expect(sanitizeNutritionGoalImageName('a'.repeat(300)).length).toBeLessThanOrEqual(80);
  });

  it('lists the markers from the root down to nutrition_goals/', () => {
    expect(nutritionGoalImageFolderKeys('cordel')).toEqual(['cordel/', 'cordel/nutrition_goals/']);
  });
});

describe('isOwnedNutritionGoalImageUrl', () => {
  const base = 'https://example.r2.cloudflarestorage.com/test-bucket';
  const saved = { ...process.env };
  process.env.CLOUDFLARE_R2_ENDPOINT = 'https://example.r2.cloudflarestorage.com';
  process.env.CLOUDFLARE_R2_BUCKET = 'test-bucket';

  it("is true only under the owner's own nutrition_goals/ folder", () => {
    const prefix = 'gyms/7-Fit';
    expect(isOwnedNutritionGoalImageUrl(`${base}/${prefix}/nutrition_goals/1-x.webp`, prefix)).toBe(true);
    expect(isOwnedNutritionGoalImageUrl(`${base}/${prefix}/nutrition/1-x.webp`, prefix)).toBe(false);
    expect(isOwnedNutritionGoalImageUrl(`${base}/${prefix}/goals/1-x.png`, prefix)).toBe(false);
    expect(isOwnedNutritionGoalImageUrl(`${base}/gyms/8-Other/nutrition_goals/1-x.webp`, prefix)).toBe(false);
    // A gym never owns the platform's object, nor the platform a gym's.
    expect(isOwnedNutritionGoalImageUrl(`${base}/cordel/nutrition_goals/1-x.webp`, prefix)).toBe(false);
    expect(isOwnedNutritionGoalImageUrl(`${base}/${prefix}/nutrition_goals/1-x.webp`, 'cordel')).toBe(false);
    expect(isOwnedNutritionGoalImageUrl('https://elsewhere.test/nutrition_goals/1.webp', prefix)).toBe(false);
    expect(isOwnedNutritionGoalImageUrl(null, prefix)).toBe(false);
    expect(isOwnedNutritionGoalImageUrl(`${base}/${prefix}/nutrition_goals/1-x.webp`, null)).toBe(false);
    Object.assign(process.env, saved);
  });
});

describe('kind declarations', () => {
  it('give the WebP image to Nutrition Goals only and the translations to both kinds', () => {
    expect(goalKindHasWebpImage('nutrition')).toBe(true);
    expect(goalKindHasWebpImage('personal')).toBe(false);
    expect(goalKindIsTranslated('nutrition')).toBe(true);
    expect(goalKindIsTranslated('personal')).toBe(true);
  });
});

describe('goal translations payload', () => {
  it('accepts name and description per supported non-base locale', () => {
    expect(validateGoalTranslations({ es: { name: 'Agua', description: 'Beber' }, ca: { name: 'Aigua' } })).toBeNull();
  });

  it('refuses the base locale, an unknown locale, non-objects, over-long text and a description with no name', () => {
    expect(validateGoalTranslations({ en: { name: 'Water' } })?.error).toMatch(/base locale/);
    expect(validateGoalTranslations({ xx: { name: 'Water' } })?.error).toMatch(/unsupported locale/);
    expect(validateGoalTranslations({ es: 'Agua' })?.error).toMatch(/must be an object/);
    expect(validateGoalTranslations([])?.error).toMatch(/keyed by locale/);
    expect(validateGoalTranslations({ es: { name: 'x'.repeat(256) } })?.error).toMatch(/255/);
    expect(validateGoalTranslations({ es: { name: 'Agua', description: 'x'.repeat(1001) } })?.error).toMatch(/1000/);
    expect(validateGoalTranslations({ es: { description: 'Sin nombre' } })?.error).toMatch(/name is required/);
  });

  it('leaves the stored rows alone when the field is absent, and clears with {}', () => {
    expect(parseGoalTranslations({})).toEqual({});
    expect(parseGoalTranslations({ translations: {} })).toEqual({ translations: {} });
  });

  it('reports {} rather than NULL for a goal with none', () => {
    expect(withGoalTranslations({ translations: null } as any).translations).toEqual({});
    expect(withGoalTranslations({ translations: '{"es":{"name":"A"}}' } as any).translations).toEqual({ es: { name: 'A' } });
  });
});

describe('translated search', () => {
  it('matches the translated names only for a translated kind', () => {
    expect(buildGoalListWhere('agua', ['1=1'], [], { searchTranslations: true }).params).toHaveLength(3);
    expect(buildGoalListWhere('agua', ['1=1'], [], { searchTranslations: true }).where).toContain('nutrition_goal_translations');
    expect(buildGoalListWhere('agua', ['1=1']).params).toHaveLength(2);
  });
});

describe('Personal Goal translations (#1719)', () => {
  const personalMigration = require(join(__dirname, '..', 'infra', 'migrations', '292_personal_goal_translations.js'));

  it('read and write personal_goal_translations, not the nutrition table', () => {
    expect(goalTranslationsExpr('g', 'translations', 'personal')).toContain('personal_goal_translations');
    expect(goalTranslationsExpr('g', 'translations', 'personal')).toContain('personal_goal_id');
    expect(localizedGoalExprs('g', 'es', 'personal')).toContain('personal_goal_translations');
    expect(localizedGoalExprs('g', 'es')).toContain('nutrition_goal_translations');
    const where = buildGoalListWhere('peso', ['1=1'], [], { searchTranslations: true, translationKind: 'personal' }).where;
    expect(where).toContain('personal_goal_translations');
    expect(where).not.toContain('nutrition_goal_translations');
  });

  it("seeds the seven System goals in step with the migration", () => {
    expect(personalMigration.SEEDS).toEqual(SYSTEM_PERSONAL_GOAL_TRANSLATIONS);
    expect(Object.keys(SYSTEM_PERSONAL_GOAL_TRANSLATIONS).sort()).toEqual(SYSTEM_PERSONAL_GOALS.map((g) => g.slug).sort());
  });
});

describe('System goal seeds', () => {
  it('cover all seven System goals in es and ca', () => {
    expect(Object.keys(SYSTEM_NUTRITION_GOAL_TEXTS).sort()).toEqual(SYSTEM_NUTRITION_GOALS.map((g) => g.slug).sort());
    for (const text of Object.values(SYSTEM_NUTRITION_GOAL_TEXTS)) {
      expect(text.es.name).toBeTruthy();
      expect(text.ca.name).toBeTruthy();
    }
  });

  it("agree with migration 282's own copy", () => {
    expect(migration.SEEDS).toEqual(SYSTEM_NUTRITION_GOAL_TEXTS);
  });
});
