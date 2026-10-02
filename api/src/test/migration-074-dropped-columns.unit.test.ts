// #1009: a gate for the defect class, not a fourth point fix.
//
// Migration 074 (#154) moved the result type from the block down to the exercise
// instance and dropped six columns. Two tickets have now found three queries
// still reading one of them, one at a time:
//
//   #966  GET /training-plan-templates/:id/hierarchy  — `b.result_type`
//   #1009  POST /me/workout-block-logs                 — `wb.result_type`
//   #1009  apps/member .../training/page.tsx           — `block.result_type`
//
// The first two were 500s; the third threw while rendering any block, because
// the server stopped sending the field at #154 and `undefined.toLowerCase()` is
// a TypeError. None was caught, because nothing asserted the *absence* of a
// dropped column. This file does, over every production `.ts`/`.tsx` file, with
// no per-file exemptions — in particular none for the two routers and the page
// that had it. The `.js` migrations are outside the scan and legitimately name
// these columns: 071 and 042 added them, 074 and 209 drop them.
//
// The four names below are checkable without parsing SQL, because after
// migration 209 no table in the schema has a column with any of them
// (`information_schema` reports zero rows for each). `duration_seconds` is
// deliberately **not** in the set: 074 dropped it from
// `workout_template_exercises` only, and it is still a real column of
// `workout_blocks`, `workout_template_blocks` and `exercise_logs`, so a
// name-based rule cannot speak about it.
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const API_SRC = join(__dirname, '..');
const MEMBER_SRC = join(__dirname, '..', '..', '..', 'apps', 'member', 'src');

const DROPPED_COLUMNS = ['result_type', 'exercise_type', 'distance_value', 'distance_unit'] as const;

/**
 * Whole-word, so the current spellings are not matched: `result_types` (the
 * catalogue table), `result_type_id` (the exercise instance's column) and the
 * `result_type_slug`/`result_type_name` a JSON tree projects from the join.
 */
const pattern = (column: string) => new RegExp(`(?<![\\w])${column}(?![\\w])`);

/**
 * Each root's own `test` directory is excluded, and that is the only exclusion.
 * A test asserting that a dropped column is absent has to name it — every
 * current occurrence in either one is a `not.toContain`/`not.toHaveProperty`,
 * or the bad SQL used as a fixture by `http-error-response.unit.test.ts`.
 * Production source gets no exemption of any kind, in particular none for the
 * two routers and the page that shipped the defect; the test below asserts all
 * three are in the scan, so this cannot quietly become a vacuous pass.
 */
const isTestFile = (root: string, file: string) =>
  relative(root, file).split(sep)[0] === 'test';

function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '.next') continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry) && !isTestFile(root, full)) out.push(full);
    }
  };
  walk(root);
  return out;
}

/** Code only — a line documenting why the column is gone is the point of it. */
const codeOf = (contents: string) => contents
  .split('\n')
  .filter((line) => {
    const t = line.trim();
    return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
  })
  .join('\n');

function offendersIn(root: string, label: string): string[] {
  const offenders: string[] = [];
  for (const file of sourceFiles(root)) {
    const code = codeOf(readFileSync(file, 'utf8'));
    for (const column of DROPPED_COLUMNS) {
      if (pattern(column).test(code)) offenders.push(`${label}/${relative(root, file)}: ${column}`);
    }
  }
  return offenders;
}

describe('no source reads a column migration 074 dropped (#1009)', () => {
  it('names none of them anywhere in the API, routers included', () => {
    expect(offendersIn(API_SRC, 'api/src')).toEqual([]);
  });

  it('names none of them anywhere in the Members App', () => {
    expect(offendersIn(MEMBER_SRC, 'apps/member/src')).toEqual([]);
  });

  it('scans the two routers that shipped the defect', () => {
    // If a refactor moved these out of the scan, the gate would pass vacuously.
    const scanned = sourceFiles(API_SRC).map((f) => relative(API_SRC, f));
    expect(scanned).toContain(join('api', 'me.ts'));
    expect(scanned).toContain(join('api', 'training-plan-templates.ts'));
    const member = sourceFiles(MEMBER_SRC).map((f) => relative(MEMBER_SRC, f));
    expect(member).toContain(join('app', '[locale]', 'training', 'page.tsx'));
  });

  it('allows the current, exercise-level spellings', () => {
    // The guard must not forbid what #154 introduced, or the next reader will
    // weaken it rather than trust it.
    const current = `
      'result_type_id', wte.result_type_id, 'result_type_slug', rt.slug,
      'result_type_name', rt.name
      LEFT JOIN result_types rt ON rt.id = we.result_type_id
    `;
    for (const column of DROPPED_COLUMNS) {
      expect(pattern(column).test(current)).toBe(false);
    }
  });

  it('would catch each of the three spellings that shipped', () => {
    for (const shipped of ["'result_type', b.result_type", 'SELECT wb.result_type FROM', "block.result_type !== 'None'"]) {
      expect(DROPPED_COLUMNS.some((c) => pattern(c).test(shipped))).toBe(true);
    }
  });
});
