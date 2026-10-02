import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// #1009 — My Training's block result is one optional, untyped free-text value.
//
// The page used to gate the caption, the input and the payload on
// `block.result_type`. Migration 074 (#154) moved the result type down to the
// exercise instance and `PLAN_TREE_SELECT` stopped sending it then, so the field
// was `undefined`: `undefined !== 'None'` passed and `undefined.toLowerCase()`
// threw while rendering any block — the page was down ahead of the Mark done
// button that was reported as the 500. Migration 209 dropped the matching
// `workout_block_logs.result_type` snapshot, because nothing read it.
//
// There is no component-test infra in this repo (no testing-library, no jsdom),
// so — like my-nutrition-sections.test.ts (#932) — the page is pinned down by
// scanning its source. The repo-wide gate that no source names a column
// migration 074 dropped is api/src/test/migration-074-dropped-columns.unit.test.ts,
// which is the suite CI actually runs.

const SRC = join(__dirname, '..');
const LOCALES_DIR = join(SRC, '..', 'locales', 'base');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;
const PAGE = join(SRC, 'app', '[locale]', 'training', 'page.tsx');

const stripComments = (src: string) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
  .replace(/^\s*\/\/.*$/gm, '');

const page = stripComments(readFileSync(PAGE, 'utf-8'));

const localeMessages = (code: string): Record<string, string> =>
  JSON.parse(readFileSync(join(LOCALES_DIR, `${code}.json`), 'utf-8')).training;

describe('My Training block result (#1009)', () => {
  it('reads no block-level result type anywhere', () => {
    expect(page).not.toContain('result_type');
    // Not in the Block type either — a declared field the server never sends is
    // what made `undefined.toLowerCase()` type-check.
    expect(page).not.toMatch(/interface Block[\s\S]*?result_type/);
  });

  it('offers the result input unconditionally, with one neutral placeholder', () => {
    // Every block can carry a result now: there is no per-block way to say
    // "this one takes none", so the input is always offered and left empty
    // means no result.
    expect(page).toContain("placeholder={t('training.block_result')}");
    expect(page).not.toMatch(/\{[^}]*block\.[a-z_]+ !== 'None'[^}]*&&\s*\(?\s*<input/);
  });

  it('sends an empty input as null rather than an empty string', () => {
    expect(page).toContain("result_value: resultInputs[block.id]?.trim() || null,");
  });

  it('still logs typed, per-set results at the exercise level', () => {
    // #154 moved the result type to the exercise instance; that is where a
    // weight/reps/rpe row is logged, and this ticket does not touch it.
    expect(page).toContain("'/me/exercise-logs'");
    expect(page).toContain('set_number');
  });

  it('has the one placeholder key in every locale, and none of the retired eight', () => {
    const retired = ['none', 'time', 'rounds', 'repetitions', 'distance', 'calories', 'weight', 'score'];
    for (const code of LOCALE_CODES) {
      const messages = localeMessages(code);
      expect(messages.block_result, `${code}.training.block_result`).toBeTruthy();
      // The retired keys named the pre-#154 block-level vocabulary, which is
      // stored nowhere now — leaving them invites re-deriving it.
      for (const slug of retired) {
        expect(messages, `${code}.training.result_type_${slug}`).not.toHaveProperty(`result_type_${slug}`);
      }
    }
  });
});
