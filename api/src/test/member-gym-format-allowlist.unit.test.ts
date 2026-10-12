import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// #1246 stage 6 — the Members App half of the gym-format allowlist (the Admin's
// lives in apps/admin/src/test/gym-format-sweep.test.ts). In the API suite
// because CI runs `npm test` in `api/` only.
const SRC = path.resolve(__dirname, '../../../apps/member/src');
const AD_HOC = /toLocale(Date|Time)?String\(|Intl\.(DateTime|Number)Format\(/g;
const ALLOWED: Record<string, number> = {
  'lib/gymFormat.ts': 1, // the formatter itself
  'app/[locale]/training/page.tsx': 2, // weekday names, locale-driven
};

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'test' ? [] : files(p);
    return /\.(ts|tsx)$/.test(e.name) ? [p] : [];
  });
}

describe('Members App gym format allowlist (#1246 stage 6)', () => {
  it('has no ad hoc date/number formatting outside the allowlist', () => {
    const over: string[] = [];
    for (const abs of files(SRC)) {
      const rel = path.relative(SRC, abs).split(path.sep).join('/');
      const n = (fs.readFileSync(abs, 'utf8').match(AD_HOC) ?? []).length;
      if (n > (ALLOWED[rel] ?? 0)) over.push(`${rel}: ${n} ad hoc call(s), ${ALLOWED[rel] ?? 0} allowed`);
    }
    expect(over).toEqual([]);
  });

  it('the two gymFormat copies stay identical below the header', () => {
    const body = (p: string) => fs.readFileSync(p, 'utf8').split('\n').slice(5).join('\n');
    expect(body(path.join(SRC, 'lib/gymFormat.ts')))
      .toBe(body(path.resolve(SRC, '../../admin/src/lib/gymFormat.ts')));
  });
});
