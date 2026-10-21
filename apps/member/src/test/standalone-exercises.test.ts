import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// #1916 — the Add Exercise section of My Training. No component-test infra, so
// (like training-block-result.test.ts) the wiring is pinned by source scan; the
// behaviour is covered by api/src/test/me-standalone-exercises.test.ts.
const SRC = join(__dirname, '..');
const page = readFileSync(join(SRC, 'app', '[locale]', 'training', 'page.tsx'), 'utf8');
const section = readFileSync(join(SRC, 'components', 'StandaloneExercises.tsx'), 'utf8');

describe('My Training — Add Exercise (#1916)', () => {
  it('renders the section for the selected day', () => {
    expect(page).toContain('<StandaloneExercises date={selectedDate} />');
  });
  it('offers Register, never Mark done, and logs through the exercise-log model', () => {
    expect(section).toContain("t('register')");
    expect(section).not.toContain('mark_done');
    expect(section).toContain('standalone_exercise_id');
    expect(section).toContain('/me/exercise-logs');
  });
  it('has its locale keys in every language', () => {
    for (const code of ['en', 'es', 'ca']) {
      const training = JSON.parse(readFileSync(join(SRC, '..', 'locales', 'base', `${code}.json`), 'utf8')).training;
      for (const key of ['standalone_title', 'standalone_add', 'standalone_search', 'standalone_none', 'standalone_empty']) {
        expect(training[key], `${code}.${key}`).toBeTruthy();
      }
    }
  });
});
