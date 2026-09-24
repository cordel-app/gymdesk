import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// #635 stage 10 — the Member app's My Membership page lists the *assignment's*
// benefits, not a Plan-keyed benefit vocabulary.
//
// Until this stage the section rendered `membership_plan_benefits` rows through
// a fixed `membership.benefit.<code>` label set (P1.4). Those rows were keyed to
// the live Membership Plan and nothing had written one since 2025; the page now
// renders the Sellable Items the member's own Assigned Plan carries, at the
// quantity, frequency and price they were agreed at (§13/§14/§17).
//
// The Member app has no component-test infra (no testing-library, no jsdom —
// same note as nutrition-food-carousel.test.ts), so the page is pinned down by
// scanning its source.

const SRC = join(__dirname, '..');
const PAGE = join(SRC, 'app', '[locale]', 'membership', 'page.tsx');
const LOCALES_DIR = join(SRC, '..', 'locales', 'base');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const page = stripComments(readFileSync(PAGE, 'utf-8'));

function locale(code: string): any {
  return JSON.parse(readFileSync(join(LOCALES_DIR, `${code}.json`), 'utf-8'));
}

describe('My Membership — the benefits section reads the snapshot (#635 stage 10)', () => {
  it('renders each line\'s own name rather than a benefit-code label', () => {
    expect(page).toContain('{b.name}');
    expect(page).not.toContain('membership.benefit.');
    expect(page).not.toContain('benefit_code');
  });

  it('groups the lines one-off → session → period, as every staff surface does', () => {
    expect(page).toContain("const BENEFIT_GROUPS: BenefitCategory[] = ['oneoff', 'session', 'periodical']");
    expect(page).toContain('membership.benefit_group.${group}');
  });

  it('shows the frozen unit price and the frozen billing frequency', () => {
    expect(page).toContain('b.unit_price.toFixed(2)');
    expect(page).toContain('membership.frequency.${b.billing_frequency}');
  });

  it('keys a line per assignment benefit, not per index', () => {
    expect(page).toContain('key={`${b.category}-${b.gym_charge_id}`}');
  });

  it('has no recurrence label left over from the retired vocabulary', () => {
    expect(page).not.toContain('membership.recurrence.');
  });
});

describe('locale parity for the new keys', () => {
  const GROUPS = ['oneoff', 'session', 'periodical'];
  const FREQUENCIES = ['once', 'per_session', 'week', 'four_weeks', 'month', 'year'];

  it.each(LOCALE_CODES)('%s carries every benefit group and frequency label', (code) => {
    const { membership } = locale(code);
    for (const g of GROUPS) expect(membership.benefit_group[g]).toBeTruthy();
    for (const f of FREQUENCIES) expect(membership.frequency[f]).toBeTruthy();
  });

  it.each(LOCALE_CODES)('%s drops the retired benefit-code vocabulary', (code) => {
    const { membership } = locale(code);
    expect(membership.benefit).toBeUndefined();
    expect(membership.recurrence).toBeUndefined();
  });
});
