// Unit tests for the #644 nutritional-quality classification table — pure data,
// no DB dependency. Guards the properties the migration relies on: that every
// system item was reviewed, that only real catalogue slugs are used, and that
// the review never drops a tag migration 127 (#350) already created.

import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(__filename);
const migration = require('../infra/migrations/167_nutrition_library_quality_review.js') as {
  CLASSIFICATION: { name: string; qualities: string[]; note: string }[];
  QUALITY_SLUGS: string[];
};

const { CLASSIFICATION, QUALITY_SLUGS } = migration;

/** The 32 system items seeded by migration 078 (#163), in seed order. */
const SYSTEM_ITEMS = [
  'Chicken', 'Beef', 'Turkey', 'Salmon', 'Tuna', 'Eggs', 'Tofu',
  'Rice', 'Brown Rice', 'Vegetables', 'Salad', 'Potatoes', 'Sweet Potatoes', 'Pasta', 'Quinoa',
  'Tomato Sauce', 'Yogurt Sauce', 'Olive Oil', 'Mustard', 'Hot Sauce',
  'Water', 'Coffee', 'Tea', 'Juice',
  'Fruit', 'Yogurt', 'Oats', 'Honey',
  'Bread', 'Nuts', 'Dairy', 'Sugar',
];

/** The assignments migration 127 (#350) created — this review is additive only. */
const TAGGED_BY_127: Record<string, string[]> = {
  protein: ['Chicken', 'Beef', 'Turkey', 'Salmon', 'Tuna', 'Eggs', 'Tofu', 'Yogurt', 'Nuts'],
  carbohydrate: ['Rice', 'Brown Rice', 'Potatoes', 'Sweet Potatoes', 'Pasta', 'Quinoa', 'Oats', 'Bread', 'Fruit', 'Honey', 'Sugar'],
};

describe('nutrition library quality classification (#644)', () => {
  it('reviews every system item exactly once, and nothing else', () => {
    const names = CLASSIFICATION.map((row) => row.name);
    expect(new Set(names).size).toBe(names.length);
    expect([...names].sort()).toEqual([...SYSTEM_ITEMS].sort());
  });

  it('uses only slugs that exist in the nutritional_qualities catalogue', () => {
    expect([...QUALITY_SLUGS].sort()).toEqual(['carbohydrate', 'fat', 'fiber', 'protein']);
    for (const { name, qualities } of CLASSIFICATION) {
      for (const slug of qualities) {
        expect(QUALITY_SLUGS, `${name} → ${slug}`).toContain(slug);
      }
      expect(new Set(qualities).size, `${name} lists a quality twice`).toBe(qualities.length);
    }
  });

  it('records the reasoning for every item, including the ones left untagged', () => {
    for (const { name, note } of CLASSIFICATION) {
      expect(note?.trim().length, `${name} has no review note`).toBeGreaterThan(0);
    }
  });

  it('assigns every quality to at least one item', () => {
    const assigned = new Set(CLASSIFICATION.flatMap((row) => row.qualities));
    // fat and fiber were at zero assignments before this ticket — that gap is
    // precisely what #644 closes, so a regression here is worth failing on.
    for (const slug of QUALITY_SLUGS) {
      expect([...assigned], `no item is tagged ${slug}`).toContain(slug);
    }
  });

  it('keeps every assignment migration 127 already made', () => {
    const byName = new Map(CLASSIFICATION.map((row) => [row.name, row.qualities]));
    for (const [slug, names] of Object.entries(TAGGED_BY_127)) {
      for (const name of names) {
        expect(byName.get(name), `${name} lost its ${slug} tag`).toContain(slug);
      }
    }
  });

  it('leaves trace-only foods untagged', () => {
    const untagged = CLASSIFICATION.filter((row) => row.qualities.length === 0).map((row) => row.name);
    expect([...untagged].sort()).toEqual(
      ['Coffee', 'Hot Sauce', 'Mustard', 'Tea', 'Tomato Sauce', 'Water', 'Yogurt Sauce'].sort(),
    );
  });
});
