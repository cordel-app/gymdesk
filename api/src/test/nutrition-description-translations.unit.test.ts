import { describe, expect, it } from 'vitest';
import {
  localizedDescriptionSql,
  parseDescriptionTranslations,
  validateDescriptionTranslations,
} from '../domain/nutritionDescriptionTranslations';
import { BASE_LOCALE } from '../infra/locale';

/** #1720 — pure rules for Nutrition Library item description translations. */
describe('localizedDescriptionSql()', () => {
  it('is the plain column for the base locale', () => {
    const sql = localizedDescriptionSql('nli', BASE_LOCALE);
    expect(sql).toBe('nli.description');
  });
  it('falls back to the base description when the locale has no (or a blank) row', () => {
    const sql = localizedDescriptionSql('nli', 'es' as any);
    expect(sql).toContain("NULLIF(nlidt.description, '')");
    expect(sql).toContain("nlidt.locale = 'es'");
    expect(sql).toContain('nli.description)');
  });
});

describe('payload validation', () => {
  it('accepts supported non-base locales with string values', () => {
    expect(validateDescriptionTranslations({ es: 'hola', ca: 'hola' })).toBeNull();
  });
  it('rejects the base locale, unknown locales, non-strings and bad shapes', () => {
    expect(validateDescriptionTranslations({ [BASE_LOCALE]: 'x' })?.error).toMatch(/base locale/);
    expect(validateDescriptionTranslations({ xx: 'x' })?.error).toMatch(/unsupported/);
    expect(validateDescriptionTranslations({ es: 5 })?.error).toMatch(/string/);
    expect(validateDescriptionTranslations([])?.error).toMatch(/object/);
    expect(validateDescriptionTranslations(null)?.error).toMatch(/object/);
  });
  it('rejects values over the description limit', () => {
    expect(validateDescriptionTranslations({ es: 'x'.repeat(1001) })?.error).toMatch(/1000/);
  });
  it('an omitted field leaves rows alone; an explicit {} clears them', () => {
    expect(parseDescriptionTranslations({})).toEqual({});
    expect(parseDescriptionTranslations({ description_translations: {} })).toEqual({ value: {} });
    expect(parseDescriptionTranslations({ description_translations: 3 }).error).toBeTruthy();
  });
});
