import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { STORED_PRODUCT_FREQUENCIES } from '../domain/productFrequency';

// #1128 — a billing frequency reads the same wherever it is displayed.
//
// The values are unchanged: `products.billing_frequency` still holds the four
// offered ones plus the two retired ones (#821/#945), and a Membership Plan's
// cadence is still the `(interval, unit)` pair #820 narrowed to two. What the
// ticket standardizes is the *label*, which had been spelled five times — the
// same monthly Product read `Month` on the Products page, `Month(s)` in a
// Membership Plan's benefit row and in a Promotion's, and `Monthly` on an
// Assigned Plan card, while a Plan billed every four weeks read `4 Weeks`.
//
// Nothing at runtime notices that drifting back. Every spelling renders
// perfectly well; they are simply different words for one thing, and the next
// page added would pick whichever namespace it happened to use. So the gate is
// what says there is one namespace, that its English words are the ticket's
// table, that no namespace carries a copy of them, and that the Members App —
// which shares no frontend module with the admin app — says the same.
//
// It lives in the API suite for #1009's reason: CI runs `npm test` in `api/` only.

const REPO = join(__dirname, '..', '..', '..');
const ADMIN = join(REPO, 'apps', 'admin');
const MEMBER = join(REPO, 'apps', 'member');
const LOCALES = ['en', 'es', 'ca'] as const;

/** The ticket's own table, plus the two retired values it leaves displayable. */
const ENGLISH_LABELS: Record<string, string> = {
  once: 'Once',
  four_weeks: 'Every 4 weeks',
  month: 'Monthly',
  year: 'Yearly',
  week: 'Weekly',
  per_session: 'Per session',
};

function read(...parts: string[]): string {
  return readFileSync(join(...parts), 'utf-8');
}

function messages(app: string, code: string): any {
  return JSON.parse(read(app, 'locales', 'base', `${code}.json`));
}

function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry === 'node_modules' || entry === 'test') continue;
        walk(full);
      } else if (/\.tsx?$/.test(entry)) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out;
}

describe('the labels live in one namespace (#1128)', () => {
  it('the admin module labels exactly the values the column may hold', () => {
    const module = read(ADMIN, 'src', 'lib', 'billingFrequency.ts');
    const declared = (module.match(/export const LABELLED_BILLING_FREQUENCIES = \[([\s\S]*?)\] as const;/) ?? [])[1];
    expect(declared, 'LABELLED_BILLING_FREQUENCIES is not declared as a literal list').toBeTruthy();
    const values = [...(declared as string).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    // The API is what enforces which may be written; this list is only what may
    // be *read back*, so it is the stored set and never a subset of it — a value
    // missing here renders `—` for a frequency the item really has.
    expect([...values].sort()).toEqual([...STORED_PRODUCT_FREQUENCIES].sort());
  });

  for (const code of LOCALES) {
    it(`${code} labels every value once, in the billing_frequency namespace`, () => {
      const ns = messages(ADMIN, code).billing_frequency;
      expect(ns, `${code}.json has no billing_frequency namespace`).toBeTruthy();
      for (const value of STORED_PRODUCT_FREQUENCIES) {
        expect(ns[`frequency_${value}`], `${code}.billing_frequency.frequency_${value}`).toBeTruthy();
      }
    });
  }

  it('reads Once / Every 4 weeks / Monthly / Yearly in English, as the ticket writes them', () => {
    const ns = messages(ADMIN, 'en').billing_frequency;
    for (const [value, label] of Object.entries(ENGLISH_LABELS)) {
      expect(ns[`frequency_${value}`], `billing_frequency.frequency_${value}`).toBe(label);
    }
  });

  // The ambiguous forms the ticket names. `Month(s)` and `Year(s)` said how long
  // something lasts where the question was how often it bills.
  it('no namespace keeps a second spelling of a frequency', () => {
    for (const code of LOCALES) {
      const all = messages(ADMIN, code);
      for (const [name, section] of Object.entries(all) as [string, any][]) {
        if (name === 'billing_frequency' || typeof section !== 'object' || section === null) continue;
        for (const value of STORED_PRODUCT_FREQUENCIES) {
          for (const prefix of ['frequency_', 'services_frequency_', 'billing_frequency_']) {
            expect(
              section[`${prefix}${value}`],
              `${code}.${name}.${prefix}${value} is a second spelling of a billing frequency`,
            ).toBeUndefined();
          }
        }
      }
    }
  });

  it('a Session Benefit keeps its own frequency vocabulary, Weekly included', () => {
    // #918 is a different question — how often an allowance *renews* — with its
    // own accepted set, and this ticket must not touch it.
    for (const code of LOCALES) {
      const plans = messages(ADMIN, code).plans;
      for (const key of ['session_frequency_none', 'session_frequency_once', 'session_frequency_week',
        'session_frequency_four_weeks', 'session_frequency_month', 'session_frequency_year']) {
        expect(plans[key], `${code}.plans.${key}`).toBeTruthy();
      }
    }
    expect(messages(ADMIN, 'en').plans.session_frequency_week).toBe('Weekly');
  });

  it('a Plan counts a duration in periods, which is a different sentence', () => {
    // `2 × 4 Weeks` (#892 §9), never `2 × Every 4 weeks`.
    for (const code of LOCALES) {
      const plans = messages(ADMIN, code).plans;
      expect(plans.period_unit_month, `${code}.plans.period_unit_month`).toBeTruthy();
      expect(plans.period_unit_four_weeks, `${code}.plans.period_unit_four_weeks`).toBeTruthy();
    }
    expect(messages(ADMIN, 'en').plans.period_unit_month).toBe('Month');
    expect(messages(ADMIN, 'en').plans.period_unit_four_weeks).toBe('4 Weeks');
  });
});

describe('every surface resolves them from that one place (#1128)', () => {
  it('no page or component interpolates a frequency into a key of its own', () => {
    // The one carve-out is the module that owns the mapping. It is named here by
    // rule rather than read from an allowlist, so a second place cannot be added
    // by adding a line to a list.
    const OWNER = join(ADMIN, 'src', 'lib', 'billingFrequency.ts');
    const offenders: string[] = [];
    for (const file of sourceFiles(join(ADMIN, 'src'))) {
      if (file === OWNER) continue;
      const src = withoutComments(read(file));
      // `session_frequency_${…}` is #918's own set and legitimate; what is
      // forbidden is a surface building a *billing* frequency key itself.
      if (/[^_]\bfrequency_\$\{/.test(src) || /services_frequency_\$\{/.test(src) || /billing_frequency_\$\{/.test(src)) {
        offenders.push(file.replace(ADMIN, 'apps/admin'));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the three Assigned Plan surfaces name the cadence rather than printing the pair', () => {
    // `1 / month` and `1 × Month` were the stored pair read out loud.
    for (const file of ['AssignedPlanExpandedRow.tsx', 'AssignedPlanDetailsModal.tsx', 'AssignedPlanConfiguration.tsx']) {
      const src = read(ADMIN, 'src', 'components', 'assignedPlan', file);
      expect(src, `${file} does not call cadenceFrequencyLabel()`).toContain('cadenceFrequencyLabel(');
      expect(withoutComments(src), `${file} still prints the stored pair`)
        .not.toMatch(/recurring_billing_interval\} [/×] \$\{/);
    }
  });

  it('the Plans page and the Products page read the shared namespace', () => {
    for (const file of [
      join(ADMIN, 'src', 'app', '[locale]', 'plans', 'page.tsx'),
      join(ADMIN, 'src', 'app', '[locale]', 'plans', 'PlanDetailModal.tsx'),
      join(ADMIN, 'src', 'app', '[locale]', 'financials', 'products', 'page.tsx'),
      join(ADMIN, 'src', 'components', 'ProductBenefits.tsx'),
      join(ADMIN, 'src', 'components', 'assignedPlan', 'AdditionalPeriodicServices.tsx'),
    ]) {
      expect(read(file), `${file} does not use BILLING_FREQUENCY_NAMESPACE`)
        .toContain('BILLING_FREQUENCY_NAMESPACE');
    }
  });
});

describe('the Members App says the same words (#1128)', () => {
  // The two apps share no frontend module, so the Members App carries its own
  // map and this is what keeps the two from naming one frequency differently.
  it('labels every value, matching the admin label in each locale', () => {
    for (const code of LOCALES) {
      const member = messages(MEMBER, code).membership?.frequency;
      const admin = messages(ADMIN, code).billing_frequency;
      expect(member, `${code}.json has no membership.frequency map`).toBeTruthy();
      for (const value of STORED_PRODUCT_FREQUENCIES) {
        expect(member[value], `${code} member membership.frequency.${value}`).toBeTruthy();
        expect(member[value], `${code} member and admin disagree about ${value}`)
          .toBe(admin[`frequency_${value}`]);
      }
    }
  });
});
