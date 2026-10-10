import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MUSCLE_KEYS } from '../domain/muscles';

// #1368 stage 1: the migration cannot import application code, so it mirrors
// MUSCLE_KEYS. This fails the build if the two drift.
const source = readFileSync(
  join(__dirname, '../infra/migrations/253_muscles_catalogue.js'),
  'utf8',
);

describe('migration 253 muscle catalogue seed', () => {
  it('seeds exactly the MUSCLE_KEYS slugs', () => {
    const seeded = [...source.matchAll(/\['([a-z0-9_]+)',\s*'[^']+'\]/g)].map((m) => m[1]);
    expect(seeded.sort()).toEqual([...MUSCLE_KEYS].sort());
  });

  it('keeps the old exercise_muscles.muscle column (stage 1 changes no behaviour)', () => {
    expect(source).not.toMatch(/DROP COLUMN muscle\b(?!_id)/);
  });
});
