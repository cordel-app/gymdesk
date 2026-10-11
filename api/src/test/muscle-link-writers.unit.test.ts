import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// #1368 stage 2: muscle links are written only through api/exercise-muscles.ts
// and read through the catalogue, never through the legacy text column.
const SOURCES = ['api/exercises.ts', 'api/platform-exercises.ts', 'scripts/import-free-exercise-db.ts', 'domain/exerciseListFilters.ts'];

describe('muscle link access (#1368 stage 2)', () => {
  for (const file of SOURCES) {
    const src = readFileSync(join(__dirname, '..', file), 'utf8');
    it(`${file} has no INSERT into exercise_muscles and no read of em.muscle`, () => {
      expect(src).not.toMatch(/INSERT (IGNORE )?INTO exercise_muscles/);
      expect(src).not.toMatch(/\bem\.muscle\b(?!_)/);
    });
  }
});
