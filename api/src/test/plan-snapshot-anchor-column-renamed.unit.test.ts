// #2125 N3c (migration 466): the plan snapshot anchor column is renamed `anchor_plan_snapshot_id`.
// A query naming the old column would fail only at runtime, so this fails the build instead. The
// old name is matched as a whole word, so `plan_…` and `replaces_…` (other columns) pass.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const OLD = new RegExp(`\\b${['assignment', 'id'].join('_')}\\b`);

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'migrations' ? [] : sources(path);
    return /\.(ts|js)$/.test(name) ? [path] : [];
  });
}

describe('plan_snapshots names its anchor anchor_plan_snapshot_id (#2125 N3c)', () => {
  it('no source under api/src outside the migrations names the old column', () => {
    const offenders = sources(ROOT).filter((f) => OLD.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
