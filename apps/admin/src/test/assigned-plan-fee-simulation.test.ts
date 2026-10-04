import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  ASSIGNED_PLAN_TIMELINE_STATUSES,
  ASSIGNED_PLAN_TIMELINE_STATUS_LABEL_KEYS,
} from '@/components/assignedPlan/types';
import {
  exampleTimelineRowTone,
  formatExampleTimelineBilling,
} from '@/lib/exampleTimeline';

// #924 stage 3 — the Assigned Plan card's **Membership Fee Simulation**.
//
// §7 asks for the Membership Plan card's Example Timeline (#818) on an
// Assigned Plan, and §1 says how: "Do not create a separate visual system for
// Assigned Plans." So the table is the shared `components/ExampleTimeline.tsx`
// both other cards already render, the rows come from the server, and the page
// contributes nothing but labels.
//
// apps/admin has no component-test infra (docs/architecture.md's TL;DR), so the
// wiring is pinned by scanning the source the way plan-example-timeline.test.ts
// does, while the declaration's pure parts are exercised directly.

const SRC = join(__dirname, '..');
const LOCALES_DIR = join(__dirname, '..', '..', 'locales', 'base');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;
const ASSIGNED_PLANS_DIR = join(SRC, 'components', 'assignedPlan');

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const rowSrc = stripComments(
  readFileSync(join(ASSIGNED_PLANS_DIR, 'AssignedPlanExpandedRow.tsx'), 'utf-8'),
);

function assignedPlansNamespace(code: string): Record<string, string> {
  const messages = JSON.parse(readFileSync(join(LOCALES_DIR, `${code}.json`), 'utf-8'));
  return (messages.assigned_plans_page ?? {}) as Record<string, string>;
}

describe('#924 §7: the section renders the shared Example Timeline', () => {
  it('renders the shared table, not one of its own', () => {
    expect(rowSrc).toContain("import { ExampleTimeline } from '@/components/ExampleTimeline'");
    expect(rowSrc).toContain('<ExampleTimeline');
    expect(rowSrc).toContain("t('section_fee_simulation')");
  });

  it('reads the server’s projection and prices nothing itself', () => {
    expect(rowSrc).toContain('detail.example_timeline');
    // No arithmetic on a row's amount: the server quotes it, VAT included (#817).
    expect(rowSrc).not.toMatch(/example_timeline[\s\S]{0,400}?\*\s*1\.21/);
    expect(rowSrc).toContain('formatExampleTimelineBilling');
    expect(rowSrc).toContain('exampleTimelineRowTone');
  });

  it('sits between the applied Promotions and the Additional Periodic Services (§11)', () => {
    const fee = rowSrc.indexOf("t('section_fee_simulation')");
    const promotions = rowSrc.indexOf("t('section_promotions')");
    const additional = rowSrc.indexOf("t('section_additional_services')");
    expect(promotions).toBeGreaterThan(-1);
    expect(fee).toBeGreaterThan(promotions);
    expect(additional).toBeGreaterThan(fee);
  });

  it('labels every status the projection can produce, in every locale', () => {
    // next-intl prints a missing key verbatim and `t()` has no defaultValue, so
    // a status without a key would render `timeline_free_promotion` on screen.
    for (const status of ASSIGNED_PLAN_TIMELINE_STATUSES) {
      expect(ASSIGNED_PLAN_TIMELINE_STATUS_LABEL_KEYS[status]).toBeTruthy();
    }
    for (const code of LOCALE_CODES) {
      const ns = assignedPlansNamespace(code);
      for (const key of Object.values(ASSIGNED_PLAN_TIMELINE_STATUS_LABEL_KEYS)) {
        expect(ns[key], `${code}.assigned_plans_page.${key}`).toBeTruthy();
      }
      for (const key of [
        'section_fee_simulation', 'col_period', 'col_dates', 'col_status', 'col_billing',
        'timeline_anchor_note', 'timeline_dates_from', 'timeline_no_charge',
        'timeline_prepaid_periods', 'tax_included_suffix', 'timeline_disclaimer',
        'timeline_unavailable',
      ]) {
        expect(ns[key], `${code}.assigned_plans_page.${key}`).toBeTruthy();
      }
    }
  });

  it('names the Promotion where a Promotion decided the period', () => {
    // Unlike the Plan card — whose rows may only say "(benefit)", since no
    // Promotion is involved in a catalogue preview — an Assigned Plan really
    // can be inside one, and #635's Q2 answer is that the Promotion decides the
    // fee alone there. Attributing it to the Plan's own duration would name the
    // wrong agreement.
    const en = assignedPlansNamespace('en');
    expect(en[ASSIGNED_PLAN_TIMELINE_STATUS_LABEL_KEYS.free_promotion]).toContain('promotion');
    expect(en[ASSIGNED_PLAN_TIMELINE_STATUS_LABEL_KEYS.free_plan]).toContain('benefit');
  });
});

describe('the shared Billing cell and row tone', () => {
  it('reads "No charge" for a waived period, whatever it would have cost', () => {
    expect(formatExampleTimelineBilling(
      { amount: null, waived: true }, 'No charge', 'VAT included',
    )).toBe('No charge');
  });

  it('quotes the server’s amount, VAT included', () => {
    expect(formatExampleTimelineBilling(
      { amount: 70, waived: false }, 'No charge', 'VAT included',
    )).toBe('€70.00 VAT included');
  });

  it('names the periods a Pre-paid charge covers (#946)', () => {
    expect(formatExampleTimelineBilling(
      { amount: 210, waived: false }, 'No charge', 'VAT included', '3 periods prepaid',
    )).toBe('€210.00 VAT included · 3 periods prepaid');
  });

  it('reads as the empty value, never €0.00, with no price to quote', () => {
    expect(formatExampleTimelineBilling(
      { amount: null, waived: false }, 'No charge', 'VAT included',
    )).toBe('—');
  });

  it('tints a charged promotional period amber and a waived one green', () => {
    expect(exampleTimelineRowTone({ status: 'pay_promotion', waived: false })).toBe('benefit');
    expect(exampleTimelineRowTone({ status: 'free_promotion', waived: true })).toBe('free');
    expect(exampleTimelineRowTone({ status: 'prepaid_plan', waived: false })).toBe('benefit');
    expect(exampleTimelineRowTone({ status: 'pay_regular', waived: false })).toBe('regular');
  });
});
