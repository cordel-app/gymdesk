import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

// #1135 — a Periodic Promotion is configured for a **number of periods**.
//
// Nothing was added to store it: `promotion_periodical.quantity` is already what
// the billing engine counts periods with (`buildItemStream()` covers an
// occurrence while `occurrence < firstCovered + grant.quantity`, and
// `collectBillableItems()` fixes such a grant's *billed* quantity to 1 — "the
// grant covers periods, it does not say how many lockers"). So the ticket is
// what that number is **called** and what it reads as: *Duration*, captioned
// with how long that many of the Product's own billing periods is.
//
// Three things can drift back silently, which is what this gate is for:
//
//   1. the meaning being spelled per section instead of declared once, which is
//      how the three sections of a card stop being one table (#916);
//   2. the derived sentence (`3 months`) being written somewhere other than the
//      module that owns how a frequency reads (#1128), or a second namespace
//      carrying a copy of it;
//   3. a membership-only section coming back for a Product Promotion — a
//      Billing & Duration whose months decide nothing about a granted Product,
//      or a Membership Fee Simulation of a fee the Promotion does not have.
//
// It lives in the API suite for #1009's reason: CI runs `npm test` in `api/` only.

const REPO = join(__dirname, '..', '..', '..');
const ADMIN = join(REPO, 'apps', 'admin');
const LOCALES = ['en', 'es', 'ca'] as const;

/** The frequencies that name a period, so `N` of them is a duration. */
const PERIOD_FREQUENCIES = ['month', 'four_weeks', 'year', 'week'] as const;
/** The two that name none: there is no such thing as three `Once`s. */
const NON_PERIOD_FREQUENCIES = ['once', 'per_session'] as const;

function read(...parts: string[]): string {
  return readFileSync(join(...parts), 'utf-8');
}

function messages(code: string): any {
  return JSON.parse(read(ADMIN, 'locales', 'base', `${code}.json`));
}

function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

function adminSources(): string[] {
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
  walk(join(ADMIN, 'src'));
  return out;
}

const COMPONENT = join(ADMIN, 'src', 'components', 'ProductBenefits.tsx');
const PROMOTIONS_PAGE = join(ADMIN, 'src', 'app', '[locale]', 'promotions', 'page.tsx');
const FREQUENCY_LIB = join(ADMIN, 'src', 'lib', 'billingFrequency.ts');

describe('what the number column counts is declared once (#1135)', () => {
  it('the shared grid names the column from one decision, not from a literal key', () => {
    const src = withoutComments(read(COMPONENT));
    expect(src, 'benefitQuantityLabelKey() is gone').toContain('export function benefitQuantityLabelKey(');
    expect(src, 'BenefitQuantityColumn is gone').toContain("export type BenefitQuantityColumn = 'quantity' | 'duration';");
    // Its declaration, the editor's header and the column declaration the
    // read-only table renders from — so a third meaning cannot be added by
    // typing a key into one of them.
    expect(src.match(/benefitQuantityLabelKey\(/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(src, "the editor still hard-codes t('col_quantity')").not.toContain("t('col_quantity')");
  });

  it('only the Promotion card’s Periodical section counts periods', () => {
    const src = withoutComments(read(PROMOTIONS_PAGE));
    const sections = src.match(/\{ section: '(session|oneoff|periodical)'[^\n]*\}/g) ?? [];
    expect(sections.length, 'the three section declarations are not recognisable').toBe(3);
    for (const line of sections) {
      const periodical = line.includes("section: 'periodical'");
      expect(
        line.includes("quantityColumn: 'duration'"),
        `${line.slice(0, 40)}… should ${periodical ? '' : 'not '}count periods`,
      ).toBe(periodical);
    }
  });

  it('no other surface relabels it — a Plan’s periodical quantity is units per occurrence', () => {
    const offenders: string[] = [];
    for (const file of adminSources()) {
      if (file === PROMOTIONS_PAGE || file === COMPONENT) continue;
      const src = withoutComments(read(file));
      if (/quantityColumn[:=]\s*["']duration["']/.test(src) || /quantityColumn="duration"/.test(src)) {
        offenders.push(file.replace(ADMIN, 'apps/admin'));
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('the derived duration reads from one place (#1135, #1128)', () => {
  it('the frequency module owns the key, and nothing else builds one', () => {
    const lib = withoutComments(read(FREQUENCY_LIB));
    expect(lib).toContain('export function billingFrequencyDurationKey(');
    expect(lib).toContain('export function billingFrequencyDurationLabel(');
    const offenders: string[] = [];
    for (const file of adminSources()) {
      if (file === FREQUENCY_LIB) continue;
      if (/duration_\$\{/.test(withoutComments(read(file)))) {
        offenders.push(file.replace(ADMIN, 'apps/admin'));
      }
    }
    expect(offenders).toEqual([]);
  });

  for (const code of LOCALES) {
    it(`${code} says how long N periods is, in the billing_frequency namespace`, () => {
      const ns = messages(code).billing_frequency;
      for (const value of PERIOD_FREQUENCIES) {
        expect(ns[`duration_${value}`], `${code}.billing_frequency.duration_${value}`).toBeTruthy();
      }
      for (const value of NON_PERIOD_FREQUENCIES) {
        // A value naming no period gets no key: `null` is what makes the caller
        // fall back to the bare number rather than print the key itself.
        expect(ns[`duration_${value}`], `${code}.billing_frequency.duration_${value} names no period`).toBeUndefined();
      }
    });
  }

  it('the count is pluralised by the message, not composed by a caller', () => {
    const en = messages('en').billing_frequency;
    expect(en.duration_month).toContain('plural');
    expect(en.duration_year).toContain('plural');
    expect(en.duration_week).toContain('plural');
    // A 4-week period keeps the `×` form the Plans page already uses for a
    // duration counted in them (`2 × 4 Weeks`, #892 §9) — "3 every 4 weeks" is
    // not a sentence.
    expect(en.duration_four_weeks).toContain('4 weeks');
  });

  it('no other namespace keeps a copy of the sentence', () => {
    for (const code of LOCALES) {
      for (const [name, section] of Object.entries(messages(code)) as [string, any][]) {
        if (name === 'billing_frequency' || typeof section !== 'object' || section === null) continue;
        for (const value of [...PERIOD_FREQUENCIES, ...NON_PERIOD_FREQUENCIES]) {
          expect(
            section[`duration_${value}`],
            `${code}.${name}.duration_${value} is a second spelling of a duration`,
          ).toBeUndefined();
        }
      }
    }
  });

  it('the editor explains what a Duration counts, in all three languages', () => {
    for (const code of LOCALES) {
      expect(messages(code).promotions.item_duration_hint, `${code}.promotions.item_duration_hint`).toBeTruthy();
    }
  });
});

describe('a Product Promotion shows no membership-only section (#1135, #926)', () => {
  const src = withoutComments(read(PROMOTIONS_PAGE));

  it('Billing & Duration is behind the target in both halves of the card', () => {
    // The form's section and the read-only summary, each gated by the predicate
    // the rest of the card already asks — hidden, never disabled, and with the
    // stored months left exactly as they are.
    const form = src.indexOf("CardSectionHeader title={t('section_billing_duration')}");
    expect(form, 'the Billing & Duration form section is gone').toBeGreaterThan(-1);
    expect(src.slice(Math.max(0, form - 400), form)).toContain('targetsMembershipPlan(editForm.applies_to) && (');
    expect(src).toContain('targetsMembershipPlan(target) && (free > 0');
  });

  it('the Membership Fee Simulation is not rendered, and not fetched, for one', () => {
    expect(src).toContain('cardTargetsMembershipPlan(promo) && renderTimeline()');
    expect(src).toContain('targetsMembershipPlan(editForm.applies_to) && renderTimeline()');
    expect(src, 'the timeline is still fetched for a Product Promotion')
      .toContain("targetsMembershipPlan(useForm ? editForm.applies_to : promo!.applies_to)");
  });

  it('the Billing Event Simulation stays, because it is about the Products', () => {
    expect(src).toContain('{renderBillingEventSimulation(promo)}');
    expect(src, 'the Billing Event Simulation was gated on the target too')
      .not.toMatch(/targetsMembershipPlan\([^)]*\) && renderBillingEventSimulation/);
  });
});

describe('a Duration is a whole number of periods (#1135 §13)', () => {
  it('the section PUT reads it as one rather than truncating it', () => {
    const src = withoutComments(read(join(__dirname, '..', 'api', 'promotion-details.ts')));
    // `parseInt('3.5')` is 3: a fractional Duration used to be stored silently as
    // a different number from the one that was configured.
    expect(src, 'quantity is parsed with parseInt again').not.toContain('parseInt(item.quantity');
    expect(src).toContain('const quantity = Number(item.quantity);');
    expect(src).toContain("!Number.isInteger(quantity) || quantity <= 0");
  });
});
