/**
 * #918 — a Session Benefit's renewal **Frequency**: the option set, the
 * replace-all input rule, the renewal arithmetic the Billing Event Simulation
 * summarises with, and the "two places" guard (the list in
 * `domain/sessionBenefitFrequency.ts` and the CHECK migration 205 writes have
 * to say the same thing, or the dropdown could offer a value the table refuses).
 *
 * Pure module, no DB (CLAUDE.md): the migration is read as a module and its
 * exported list compared, the way `product-benefit-actions.unit.test.ts`
 * reads back migration 203's.
 */

import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

import {
  RENEWING_SESSION_BENEFIT_FREQUENCIES,
  SESSION_BENEFIT_FREQUENCIES,
  describeSessionBenefitFrequencies,
  isRenewingSessionFrequency,
  isSessionBenefitFrequency,
  parseSessionBenefitFrequencyInput,
  renewalsInPeriod,
  toSessionBenefitFrequency,
} from '../domain/sessionBenefitFrequency';
import { OFFERED_PRODUCT_FREQUENCIES } from '../domain/productFrequency';

const require = createRequire(__filename);
const migration = require('../infra/migrations/205_session_benefit_frequency.js') as {
  SESSION_BENEFIT_FREQUENCIES: string[];
  TABLES: string[];
};

describe('#918 — the option set', () => {
  it('offers the five periods an allowance can renew on, in dropdown order', () => {
    expect(SESSION_BENEFIT_FREQUENCIES).toEqual(['once', 'week', 'four_weeks', 'month', 'year']);
  });

  it('offers Weekly, which the Product surface deliberately does not (#821)', () => {
    expect(SESSION_BENEFIT_FREQUENCIES).toContain('week');
    expect(OFFERED_PRODUCT_FREQUENCIES).not.toContain('week');
  });

  it('does not offer per_session — not a period, and retired by #945', () => {
    expect(SESSION_BENEFIT_FREQUENCIES).not.toContain('per_session');
  });

  it('counts everything but `once` as renewing', () => {
    expect(RENEWING_SESSION_BENEFIT_FREQUENCIES).toEqual(['week', 'four_weeks', 'month', 'year']);
    expect(isRenewingSessionFrequency('week')).toBe(true);
    expect(isRenewingSessionFrequency('once')).toBe(false);
    // `—`: the backwards-compatible default, and the same answer as `once`.
    expect(isRenewingSessionFrequency(null)).toBe(false);
  });

  it('recognizes only its own values', () => {
    expect(isSessionBenefitFrequency('month')).toBe(true);
    expect(isSessionBenefitFrequency('per_session')).toBe(false);
    expect(isSessionBenefitFrequency('')).toBe(false);
    expect(isSessionBenefitFrequency(null)).toBe(false);
  });

  it('normalizes a stored value to a known frequency or null', () => {
    expect(toSessionBenefitFrequency('four_weeks')).toBe('four_weeks');
    expect(toSessionBenefitFrequency(null)).toBeNull();
    expect(toSessionBenefitFrequency('weekly')).toBeNull();
  });

  it('names the accepted set in the 400 message', () => {
    expect(describeSessionBenefitFrequencies()).toBe('once, week, four_weeks, month, year');
  });
});

describe('#918 — the list and the CHECK agree (two places)', () => {
  it('mirrors the domain list in migration 205', () => {
    expect(migration.SESSION_BENEFIT_FREQUENCIES).toEqual([...SESSION_BENEFIT_FREQUENCIES]);
  });

  it('puts the column on the Plan table and the assignment snapshot, and nowhere else', () => {
    expect(migration.TABLES).toEqual(['membership_plan_session', 'user_membership_session']);
  });
});

describe('#918 — the replace-all input rule', () => {
  it('keeps the stored Frequency when the request names none', () => {
    expect(parseSessionBenefitFrequencyInput({ product_id: 1, quantity: 2 }))
      .toEqual({ keep: true });
  });

  it('clears it for an explicit `—`, in either spelling', () => {
    expect(parseSessionBenefitFrequencyInput({ frequency: null }))
      .toEqual({ keep: false, frequency: null });
    expect(parseSessionBenefitFrequencyInput({ frequency: '' }))
      .toEqual({ keep: false, frequency: null });
  });

  it('accepts a value from the set', () => {
    expect(parseSessionBenefitFrequencyInput({ frequency: 'week' }))
      .toEqual({ keep: false, frequency: 'week' });
  });

  it('refuses anything else rather than coercing it', () => {
    expect(parseSessionBenefitFrequencyInput({ frequency: 'per_session' }).error)
      .toMatch(/frequency must be one of/);
    expect(parseSessionBenefitFrequencyInput({ frequency: 7 }).error)
      .toMatch(/frequency must be one of/);
  });
});

describe('#918 — renewals inside a billing cycle (the Q1 summary rule)', () => {
  it('4 weekly renewals in a 4-week billing cycle', () => {
    // 2026-01-01 + 28 days = 2026-01-29.
    expect(renewalsInPeriod('2026-01-01', '2026-01-01', '2026-01-29', 'week')).toBe(4);
  });

  it('5 weekly renewals in a 31-day month, 4 in the next — never a fractional 4.35', () => {
    // Jan 1, 8, 15, 22, 29 fall in January; Feb 5, 12, 19, 26 in February.
    expect(renewalsInPeriod('2026-01-01', '2026-01-01', '2026-02-01', 'week')).toBe(5);
    expect(renewalsInPeriod('2026-01-01', '2026-02-01', '2026-03-01', 'week')).toBe(4);
  });

  it('counts the renewals of later cycles from the same anchor', () => {
    // The schedule is one series from the assignment's start date, so the third
    // 4-week cycle reports its own 4 and not a restarted count.
    expect(renewalsInPeriod('2026-01-01', '2026-02-26', '2026-03-26', 'week')).toBe(4);
  });

  it('53 weekly renewals in a 365-day year — the dates, not the nominal 52', () => {
    // A year holds 52 whole weeks *plus a day*, and the renewal on the anchor
    // itself is one of them, so a yearly cycle beginning 1 Jan 2026 contains a
    // weekly allowance on 53 distinct dates (1 Jan 2026 … 31 Dec 2026). The
    // ticket's "52x2" is the nominal figure; this counts what actually falls in
    // the period, which is what the gym's own calendar would say.
    expect(renewalsInPeriod('2026-01-01', '2026-01-01', '2027-01-01', 'week')).toBe(53);
    // One day shorter and it is the familiar 52.
    expect(renewalsInPeriod('2026-01-01', '2026-01-01', '2026-12-31', 'week')).toBe(52);
  });

  it('one monthly renewal per monthly cycle', () => {
    expect(renewalsInPeriod('2026-01-01', '2026-01-01', '2026-02-01', 'month')).toBe(1);
    expect(renewalsInPeriod('2026-01-01', '2026-03-01', '2026-04-01', 'month')).toBe(1);
  });

  it('answers 0 for a cycle a longer renewal period skips over', () => {
    // A yearly allowance on monthly billing renews in one cycle out of twelve;
    // the engine shows no line for the others rather than "0 sessions".
    expect(renewalsInPeriod('2026-01-01', '2026-02-01', '2026-03-01', 'year')).toBe(0);
  });

  it('answers 0 for `once` and for no frequency — neither renews', () => {
    expect(renewalsInPeriod('2026-01-01', '2026-01-01', '2026-02-01', 'once')).toBe(0);
    expect(renewalsInPeriod('2026-01-01', '2026-01-01', '2026-02-01', null)).toBe(0);
  });

  it('answers 0 for an empty or inverted period', () => {
    expect(renewalsInPeriod('2026-01-01', '2026-01-01', '2026-01-01', 'week')).toBe(0);
    expect(renewalsInPeriod('2026-01-01', '2026-02-01', '2026-01-01', 'week')).toBe(0);
  });
});
