import { describe, it, expect } from 'vitest';
import names from '../data/base-exercise-names.json';
import descriptions from '../data/base-exercise-descriptions.json';

// #2221: the bundled Spanish/Catalan names cover exactly the Base Exercises the
// description content covers, and fit the translation column.
describe('bundled Base Exercise names', () => {
  const entries = Object.entries(names as Record<string, { es?: string; ca?: string }>);
  it('covers the same slugs as the bundled descriptions', () => {
    expect(Object.keys(names).sort()).toEqual(Object.keys(descriptions).sort());
  });
  it('has a non-empty es and ca name within 200 characters for every exercise', () => {
    for (const [slug, v] of entries) {
      for (const l of ['es', 'ca'] as const) {
        expect(v[l]?.trim(), `${slug}.${l}`).toBeTruthy();
        expect(v[l]!.length, `${slug}.${l}`).toBeLessThanOrEqual(200);
      }
    }
  });
});
