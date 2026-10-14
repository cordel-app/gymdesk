import { describe, it, expect } from 'vitest';
import content from '../data/base-exercise-descriptions.json';
import { planDescriptionBackfill } from '../domain/exerciseDescriptionBackfill';
import { DESCRIPTION_MAX, SHORT_DESCRIPTION_MAX } from '../domain/exerciseDescriptionTranslations';

// #1608: the bundled catalogue content must give every Base Exercise all six values,
// within the limits the backfill enforces, and be a form the backfill will accept.
const entries = Object.entries(content as Record<string, Record<string, Record<string, string>>>);

describe('bundled Base Exercise descriptions (#1608)', () => {
  it('covers the whole Free Exercise DB catalogue', () => {
    expect(entries.length).toBe(876);
  });

  it('has short and full descriptions in en, es and ca for every slug, within the limits', () => {
    for (const [slug, byLocale] of entries) {
      for (const locale of ['en', 'es', 'ca']) {
        for (const [field, max] of [['short_description', SHORT_DESCRIPTION_MAX], ['description', DESCRIPTION_MAX]] as const) {
          const v = byLocale[locale]?.[field];
          expect(typeof v === 'string' && v.trim().length > 0, `${slug} ${locale}.${field}`).toBe(true);
          expect(v.length <= max, `${slug} ${locale}.${field} length`).toBe(true);
        }
      }
    }
  });

  it('writes the localized short descriptions independently of the English one', () => {
    for (const [slug, byLocale] of entries) {
      expect(byLocale.es.short_description, slug).not.toBe(byLocale.en.short_description);
      expect(byLocale.ca.short_description, slug).not.toBe(byLocale.en.short_description);
    }
  });

  it('never uses the retired term for a Member', () => {
    expect(JSON.stringify(content)).not.toMatch(/\bsocios?\b/i);
  });

  it('is accepted by the backfill as writes for an exercise with nothing stored', () => {
    const [, byLocale] = entries[0];
    const plan = planDescriptionBackfill({}, byLocale);
    expect(plan.warnings).toEqual([]);
    expect(Object.keys(plan.writes).sort()).toEqual(['ca', 'en', 'es']);
  });
});
