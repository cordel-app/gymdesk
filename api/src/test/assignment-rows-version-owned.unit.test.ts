// #1325 PR 3e-4b — an assignment carries no rows of its own: coverage is the
// chain's (`user_membership_members` is a read-only view over
// `product_set_members`) and the benefit, Promotion and service rows are the
// version's. Nothing in production code may write the view or key a child row
// by `user_membership_id`.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..');

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === 'test' || name === 'migrations') continue;
      sources(path, out);
    } else if (name.endsWith('.ts')) out.push(path);
  }
  return out;
}

const code = (file: string) => readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('an assignment has no rows of its own (#1325 PR 3e-4b)', () => {
  const files = sources(SRC);

  it('nothing writes user_membership_members', () => {
    const offenders = files.filter((f) => /(INSERT\s+(IGNORE\s+)?INTO|UPDATE|DELETE\s+FROM)\s+user_membership_members\b/i.test(code(f)));
    expect(offenders).toEqual([]);
  });

  it('no child row is keyed by user_membership_id (applied Promotions are the assignment's again, #1995)', () => {
    const tables = '(user_membership_(session|oneoff|periodical)|member_products_recurrent_snapshot)';
    const offenders = files.filter((f) => {
      const text = code(f);
      // An INSERT naming the column, or a predicate comparing it.
      const insert = new RegExp(`INSERT\\s+INTO\\s+${tables}\\s*\\([^)]*\\buser_membership_id\\b`, 'i');
      const keyed = new RegExp(`\\b(ums|umss|copy)\\.user_membership_id\\b`, 'i');
      return insert.test(text) || keyed.test(text);
    });
    expect(offenders).toEqual([]);
  });
});
