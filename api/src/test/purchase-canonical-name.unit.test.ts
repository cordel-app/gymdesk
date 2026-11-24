// #3288 — a purchase's canonical name: the gym's name, the request language's label, and the
// creation instant in the gym's Time & Localization; and migration 475's copy of the rule agrees.
import { describe, expect, it } from 'vitest';
import { canonicalPurchaseName, purchaseNameLabel } from '../domain/purchaseName';
import { formatGymDateTime } from '../domain/gymLocalization';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const migration = require('../infra/migrations/475_purchase_canonical_name.js');

const at = new Date('2026-11-23T10:56:00Z');
const madrid = { time_zone: 'Europe/Madrid', date_format: 'DD/MM/YYYY', time_format: '24h' };

describe('canonical purchase name (#3288)', () => {
  it('labels English Purchase and Spanish/Catalan Compra, and anything else falls back to English', () => {
    expect(purchaseNameLabel('en')).toBe('Purchase');
    expect(purchaseNameLabel('es')).toBe('Compra');
    expect(purchaseNameLabel('ca')).toBe('Compra');
    expect(purchaseNameLabel('fr')).toBe('Purchase');
    expect(purchaseNameLabel(null)).toBe('Purchase');
  });

  it("formats the instant in the gym's zone, date format and clock", () => {
    expect(formatGymDateTime(at, madrid)).toBe('23/11/2026 11:56');
    expect(formatGymDateTime(at, { ...madrid, date_format: 'MM/DD/YYYY', time_format: '12h' })).toBe('11/23/2026 11:56 AM');
    expect(formatGymDateTime(at, { ...madrid, date_format: 'YYYY-MM-DD' })).toBe('2026-11-23 11:56');
    expect(formatGymDateTime(at, { ...madrid, time_zone: 'America/New_York' })).toBe('23/11/2026 05:56');
    expect(formatGymDateTime(at, { ...madrid, time_zone: 'Not/AZone' })).toBe('23/11/2026 11:56');
  });

  it('composes <Gym> - <label> - <date time>, never cutting a long gym name', () => {
    expect(canonicalPurchaseName({ gymName: 'Gym Name', locale: 'es', createdAt: at, settings: madrid }))
      .toBe('Gym Name - Compra - 23/11/2026 11:56');
    expect(canonicalPurchaseName({ gymName: '  ', locale: 'en', createdAt: at, settings: madrid }))
      .toBe('Purchase - 23/11/2026 11:56');
    const long = 'G'.repeat(255);
    expect(canonicalPurchaseName({ gymName: long, locale: 'en', createdAt: at, settings: madrid }).startsWith(long)).toBe(true);
  });

  it("migration 475's copy agrees with the domain rule for an English legacy name", () => {
    for (const s of [madrid, { time_zone: 'America/New_York', date_format: 'MM/DD/YYYY', time_format: '12h' },
      { time_zone: 'Asia/Tokyo', date_format: 'YYYY-MM-DD', time_format: '24h' }]) {
      expect(migration.legacyPurchaseName('Gym X', at.toISOString(), s))
        .toBe(canonicalPurchaseName({ gymName: 'Gym X', locale: 'en', createdAt: at, settings: s }));
    }
  });
});
