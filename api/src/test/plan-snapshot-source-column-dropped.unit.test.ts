// #2125 N2 (migration 462): `plan_snapshots`' legacy assignment id column is dropped and
// `assignment_id` is the only record of a snapshot's assignment. A query naming the old column
// would fail only at runtime, so this fails the build instead.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const OLD = ['source', 'user', 'membership', 'id'].join('_');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'migrations' ? [] : sources(path);
    return /\.(ts|js)$/.test(name) ? [path] : [];
  });
}

describe('the legacy plan snapshot assignment id column is gone (#2125 N2)', () => {
  it('no source under api/src outside the migrations names it', () => {
    const offenders = sources(ROOT).filter((f) => readFileSync(f, 'utf8').includes(OLD));
    expect(offenders).toEqual([]);
  });
});
