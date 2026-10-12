import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  descriptionTranslationsExpr,
  localizedDescriptionExprs,
  parseDescriptionTranslations,
  parseShortDescription,
  validateDescriptionTranslations,
  withDescriptionTranslations,
} from '../domain/exerciseDescriptionTranslations';
import { planDescriptionBackfill } from '../domain/exerciseDescriptionBackfill';
import { BASE_LOCALE } from '../infra/locale';

/** #1419 — pure tests for exercise description translations. */
describe('localizedDescriptionExprs()', () => {
  it('collapses to the base columns for the base locale', () => {
    const sql = localizedDescriptionExprs('e', BASE_LOCALE);
    expect(sql).toContain('e.short_description AS display_short_description');
    expect(sql).toContain('e.description AS display_description');
    expect(sql).not.toContain('SELECT');
  });
  it('falls back to the base column for a translated locale, ignoring blanks', () => {
    const sql = localizedDescriptionExprs('e', 'es' as any);
    expect(sql).toContain("NULLIF(edt.description, '')");
    expect(sql).toContain("edt.locale = 'es'");
    expect(sql).toContain('e.description)');
  });
});

describe('payload validation', () => {
  it('accepts a supported non-base locale with the two fields', () => {
    expect(validateDescriptionTranslations({ es: { short_description: 'a', description: 'b' } })).toBeNull();
  });
  it('rejects the base locale, unknown locales and bad shapes', () => {
    expect(validateDescriptionTranslations({ [BASE_LOCALE]: { description: 'x' } })?.error).toMatch(/base locale/);
    expect(validateDescriptionTranslations({ xx: { description: 'x' } })?.error).toMatch(/unsupported/);
    expect(validateDescriptionTranslations({ es: 'x' })?.error).toMatch(/object/);
    expect(validateDescriptionTranslations([])?.error).toMatch(/object/);
    expect(validateDescriptionTranslations({ es: { description: 5 } })?.error).toMatch(/string/);
  });
  it('rejects over-long values', () => {
    expect(validateDescriptionTranslations({ es: { short_description: 'x'.repeat(301) } })?.error).toMatch(/300/);
  });
  it('an omitted field is "leave alone", an explicit {} is "clear"', () => {
    expect(parseDescriptionTranslations({})).toEqual({});
    expect(parseDescriptionTranslations({ description_translations: {} })).toEqual({ descriptionTranslations: {} });
    expect(parseDescriptionTranslations({ description_translations: 3 }).error).toBeTruthy();
  });
  it('short_description: absent keeps, blank clears, non-string is an error', () => {
    expect(parseShortDescription({}).provided).toBe(false);
    expect(parseShortDescription({ short_description: '' })).toEqual({ provided: true, value: null });
    expect(parseShortDescription({ short_description: ' hi ' }).value).toBe('hi');
    expect(parseShortDescription({ short_description: 4 }).error).toBeTruthy();
  });
});

describe('read shaping', () => {
  it('turns NULL into {} and parses a string aggregate', () => {
    expect(withDescriptionTranslations({ description_translations: null } as any).description_translations).toEqual({});
    expect(withDescriptionTranslations({ description_translations: '{"es":{"description":"a"}}' } as any).description_translations)
      .toEqual({ es: { description: 'a' } });
  });
  it('aggregates per locale', () => {
    expect(descriptionTranslationsExpr('e')).toContain('JSON_OBJECTAGG');
  });
});

describe('planDescriptionBackfill()', () => {
  it('fills only empty values and never overwrites', () => {
    const plan = planDescriptionBackfill(
      { en: { description: 'kept' }, es: { short_description: 'corregido' } },
      { en: { description: 'new', short_description: 'short' }, es: { short_description: 'nuevo', description: 'desc' } },
    );
    expect(plan.writes).toEqual({ en: { short_description: 'short' }, es: { description: 'desc' } });
  });
  it('warns on an over-long value and skips it', () => {
    const plan = planDescriptionBackfill({}, { es: { short_description: 'x'.repeat(301) } });
    expect(plan.writes).toEqual({});
    expect(plan.warnings).toHaveLength(1);
  });
});

describe('migration 275', () => {
  const sql = fs.readFileSync(path.join(__dirname, '../infra/migrations/275_exercise_description_translations.js'), 'utf8');
  it('adds the base column and a cascading junction keyed by (exercise_id, locale)', () => {
    expect(sql).toContain('ADD COLUMN short_description');
    expect(sql).toContain('PRIMARY KEY (exercise_id, locale)');
    expect(sql).toContain('ON DELETE CASCADE');
  });
});
