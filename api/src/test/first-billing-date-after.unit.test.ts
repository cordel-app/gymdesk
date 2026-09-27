// #790 — unit tests for firstBillingDateAfter(): pure date arithmetic, no DB.
import { describe, expect, it } from 'vitest';
import { advanceBillingDate, firstBillingDateAfter } from '../domain/billingDate';

describe('firstBillingDateAfter', () => {
  it('walks a monthly assignment back-dated three months to the first boundary after today', () => {
    // 15 Jun → 15 Jul, 15 Aug, 15 Sep (all past), 15 Oct.
    expect(firstBillingDateAfter('2026-06-15', 1, 'month', '2026-09-27')).toBe('2026-10-15');
  });

  it('is strictly after: a boundary that falls on today moves one more cycle', () => {
    expect(firstBillingDateAfter('2026-06-27', 1, 'month', '2026-09-27')).toBe('2026-10-27');
    expect(firstBillingDateAfter('2026-09-20', 1, 'week', '2026-09-27')).toBe('2026-10-04');
    expect(firstBillingDateAfter('2026-09-26', 1, 'day', '2026-09-27')).toBe('2026-09-28');
  });

  it('an assignment starting today moves exactly one cadence (the pre-#790 behaviour)', () => {
    expect(firstBillingDateAfter('2026-09-27', 1, 'month', '2026-09-27')).toBe('2026-10-27');
    expect(firstBillingDateAfter('2026-09-27', 2, 'week', '2026-09-27')).toBe('2026-10-11');
    expect(firstBillingDateAfter('2026-09-27', 1, 'year', '2026-09-27')).toBe('2027-09-27');
  });

  it('an assignment starting in the future moves exactly one cadence, however far away', () => {
    expect(firstBillingDateAfter('2026-12-01', 1, 'month', '2026-09-27')).toBe('2027-01-01');
    expect(firstBillingDateAfter('2027-03-10', 3, 'month', '2026-09-27')).toBe('2027-06-10');
  });

  it('weekly: steps whole weeks from the anchor', () => {
    // 1 Sep + 4w = 29 Sep, the first multiple after the 27th.
    expect(firstBillingDateAfter('2026-09-01', 1, 'week', '2026-09-27')).toBe('2026-09-29');
    // Every two weeks: 1 Sep → 15 Sep → 29 Sep.
    expect(firstBillingDateAfter('2026-09-01', 2, 'week', '2026-09-27')).toBe('2026-09-29');
  });

  it('daily: tomorrow, whatever the back-date', () => {
    expect(firstBillingDateAfter('2025-01-01', 1, 'day', '2026-09-27')).toBe('2026-09-28');
    // A 10-day cadence from 1 Sep: 11, 21 Sep, 1 Oct.
    expect(firstBillingDateAfter('2026-09-01', 10, 'day', '2026-09-27')).toBe('2026-10-01');
  });

  it('yearly: the next anniversary after today', () => {
    expect(firstBillingDateAfter('2023-10-01', 1, 'year', '2026-09-27')).toBe('2026-10-01');
    expect(firstBillingDateAfter('2023-09-27', 1, 'year', '2026-09-27')).toBe('2027-09-27');
  });

  it('multi-month cadence: steps in multiples of the interval', () => {
    // Quarterly from 1 Mar: 1 Jun, 1 Sep, 1 Dec.
    expect(firstBillingDateAfter('2026-03-01', 3, 'month', '2026-09-27')).toBe('2026-12-01');
  });

  it('end-of-month starts step the way the nightly run does (advanceBillingDate), cycle by cycle', () => {
    // 31 Jan + 1 month = 3 Mar (Date.setUTCMonth), then 3 Apr, 3 May …
    expect(firstBillingDateAfter('2026-01-31', 1, 'month', '2026-02-10')).toBe('2026-03-03');
    expect(firstBillingDateAfter('2026-01-31', 1, 'month', '2026-04-15')).toBe('2026-05-03');
    // Whatever it returns is a date the run itself reaches from the anchor.
    let runDate = '2026-01-31';
    const seen: string[] = [];
    for (let i = 0; i < 6; i++) { runDate = advanceBillingDate(runDate, 1, 'month'); seen.push(runDate); }
    expect(seen).toContain(firstBillingDateAfter('2026-01-31', 1, 'month', '2026-04-15'));
  });

  it('29 Feb anchors survive a yearly cadence the way the run steps them', () => {
    expect(firstBillingDateAfter('2024-02-29', 1, 'year', '2024-03-01')).toBe(advanceBillingDate('2024-02-29', 1, 'year'));
  });

  it('accepts a DATETIME-shaped string and compares on the date alone', () => {
    expect(firstBillingDateAfter('2026-06-15 00:00:00', 1, 'month', '2026-09-27 23:59:59')).toBe('2026-10-15');
  });

  it('refuses a non-positive or fractional interval rather than looping forever', () => {
    expect(() => firstBillingDateAfter('2026-01-01', 0, 'month', '2026-09-27')).toThrow(/positive integer/);
    expect(() => firstBillingDateAfter('2026-01-01', -1, 'day', '2026-09-27')).toThrow(/positive integer/);
    expect(() => firstBillingDateAfter('2026-01-01', 1.5, 'day', '2026-09-27')).toThrow(/positive integer/);
  });

  it('refuses an absurd back-date instead of walking it cycle by cycle', () => {
    expect(() => firstBillingDateAfter('1900-01-01', 1, 'day', '2026-09-27')).toThrow(/more than/);
  });
});
