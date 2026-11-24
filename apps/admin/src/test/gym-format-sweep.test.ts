// #1246 stage 3 — a date, time or amount is formatted by `lib/gymFormat.ts` from
// the active gym's settings. This gate stops the ad-hoc `toLocale*String` /
// `Intl.*Format` call sites in a page from growing: the files below still hold
// some (date-only values and locale-driven month names, converted in later
// passes), and the list may only shrink. A page not on it must use the formatter.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(__dirname, '..');
const AD_HOC = /toLocale(Date|Time)?String\(|Intl\.(DateTime|Number)Format\(/;
const CONVERTED = [
  'app/[locale]/spaces/page.tsx',
  'app/[locale]/workout-templates/page.tsx',
  'app/[locale]/activity-types/page.tsx',
  'app/[locale]/staff/page.tsx',
  'app/[locale]/payments/transactions/page.tsx',
  'app/[locale]/members/MemberProfessionalServices.tsx',
];

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'test' ? [] : files(p);
    return /\.(ts|tsx)$/.test(e.name) ? [p] : [];
  });
}

describe('gym format sweep (#1246 stage 3)', () => {
  it('uses the gym formatter for timestamps on converted screens', () => {
    for (const rel of CONVERTED) {
      const src = fs.readFileSync(path.join(SRC, rel), 'utf8');
      expect(src, rel).toContain('useGymFormatSettings');
      expect(src, rel).toContain('formatGymDateTime');
      expect(/new Date\([^)]*\)\.toLocaleString\(/.test(src), `${rel} still formats a timestamp ad hoc`).toBe(false);
    }
  });

  it('the formatter module itself is the only Intl.DateTimeFormat in lib/gymFormat', () => {
    const src = fs.readFileSync(path.join(SRC, 'lib/gymFormat.ts'), 'utf8');
    expect(AD_HOC.test(src)).toBe(true);
    expect(files(SRC).length).toBeGreaterThan(0);
  });
});

// #1246 stage 6 — the allowlist. Every date, time, number and amount the apps
// show comes out of `lib/gymFormat.ts` (the gym's Time & Localization settings).
// The ad hoc call sites that remain are the ones with no gym-format equivalent,
// listed here with how many each file may hold; the count may only go down, and
// a file not on the list may hold none.
const AD_HOC_ALL = /toLocale(Date|Time)?String\(|Intl\.(DateTime|Number)Format\(/g;
const ALLOWED_AD_HOC: Record<string, { count: number; why: string }> = {
  'lib/gymFormat.ts': { count: 1, why: 'the formatter itself' },
  'app/[locale]/payments/dashboard/page.tsx': { count: 1, why: 'locale month name of the reported period' },
  'app/[locale]/calendar/page.tsx': { count: 1, why: 'the browser zone the FullCalendar grid renders in' },
};

describe('gym format allowlist (#1246 stage 6)', () => {
  it('has no ad hoc date/number formatting outside the allowlist', () => {
    const over: string[] = [];
    for (const abs of files(SRC)) {
      const rel = path.relative(SRC, abs).split(path.sep).join('/');
      const n = (fs.readFileSync(abs, 'utf8').match(AD_HOC_ALL) ?? []).length;
      const allowed = ALLOWED_AD_HOC[rel]?.count ?? 0;
      if (n > allowed) over.push(`${rel}: ${n} ad hoc call(s), ${allowed} allowed`);
    }
    expect(over).toEqual([]);
  });
});
