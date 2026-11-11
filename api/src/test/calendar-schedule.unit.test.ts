// #2125 M5c (Oscar, 2026-11-11, Option B) — the billing calendar: monthly on the
// 1st, every 4 weeks on the 28-day grid anchored on Monday 2026-11-02, weekly on
// Mondays, yearly on the obligation's own anniversary. A monthly plan starting
// off the grid pays a prorated stretch to the next 1st plus its whole Pre-paid
// Duration, the stretch consumes no period, and regular billing starts on the 1st.

import { describe, expect, it } from 'vitest';
import { calendarAnchorOnOrBefore, isOnCalendarGrid } from '../domain/calendarSchedule';
import { allocateSchedule } from '../domain/scheduleAllocation';
import { SimulationAssignment } from '../domain/billingSimulation';
import { computeAssignmentBillingEventSimulation } from '../domain/assignmentBillingEventSimulation';
import { NO_PERSONAL_FEE_BENEFIT } from '../domain/personalFeeBenefit';
import { toPlanDuration, toPlanDurationCadence } from '../domain/planDuration';

const MONTH = { interval: 1, unit: 'month' };
const FOUR_WEEKS = { interval: 4, unit: 'week' };
const WEEK = { interval: 1, unit: 'week' };
const YEAR = { interval: 1, unit: 'year' };

describe('calendarAnchorOnOrBefore', () => {
  it('anchors a monthly schedule on the 1st of the month', () => {
    expect(calendarAnchorOnOrBefore(MONTH, '2026-10-17')).toBe('2026-10-01');
    expect(calendarAnchorOnOrBefore(MONTH, '2026-11-01')).toBe('2026-11-01');
  });
  it('anchors a 4-weekly schedule on the 28-day grid from 2026-11-02, backwards too', () => {
    expect(calendarAnchorOnOrBefore(FOUR_WEEKS, '2026-11-02')).toBe('2026-11-02');
    expect(calendarAnchorOnOrBefore(FOUR_WEEKS, '2026-11-29')).toBe('2026-11-02');
    expect(calendarAnchorOnOrBefore(FOUR_WEEKS, '2026-11-30')).toBe('2026-11-30');
    expect(calendarAnchorOnOrBefore(FOUR_WEEKS, '2026-11-01')).toBe('2026-10-05');
  });
  it('anchors a weekly schedule on the Monday on or before', () => {
    expect(calendarAnchorOnOrBefore(WEEK, '2026-11-11')).toBe('2026-11-09'); // a Wednesday
    expect(calendarAnchorOnOrBefore(WEEK, '2026-11-15')).toBe('2026-11-09'); // a Sunday
    expect(calendarAnchorOnOrBefore(WEEK, '2026-11-16')).toBe('2026-11-16');
  });
  it('keeps a yearly (or any other) schedule on its own anniversary', () => {
    expect(calendarAnchorOnOrBefore(YEAR, '2026-10-17')).toBe('2026-10-17');
    expect(calendarAnchorOnOrBefore({ interval: 2, unit: 'month' }, '2026-10-17')).toBe('2026-10-17');
    expect(isOnCalendarGrid(YEAR, '2026-10-17')).toBe(true);
  });
  it('gives a new item schedule a grid anchor', () => {
    const a = allocateSchedule({ cadence: { interval: 1, unit: 'week' }, purchaseDate: '2026-11-11', schedules: [] });
    expect(a).toMatchObject({ kind: 'new', anchorDate: '2026-11-09' });
  });
});

const START = '2026-11-17';

function plan(over: { free?: number; paid?: number; prepaid?: number } = {}): SimulationAssignment {
  return {
    userMembershipId: 1, planName: 'Monthly', startsAt: START, endsAt: null,
    membershipFeePrice: 31, recurringInterval: 1, recurringUnit: 'month',
    promotions: [], services: [], planBenefits: [],
    planDuration: toPlanDuration(over.free ?? 0, over.paid ?? 0, 0, over.prepaid ?? 0, toPlanDurationCadence(1, 'month'), false),
    personalFeeBenefit: NO_PERSONAL_FEE_BENEFIT,
    alignTo: calendarAnchorOnOrBefore(MONTH, START),
  };
}

const feeCharges = (a: SimulationAssignment) =>
  computeAssignmentBillingEventSimulation({ assignment: a, from: START }).dates
    .flatMap((g) => g.lines.filter((l) => l.kind === 'membership_fee').map((l) => ({ date: g.date, l })));

describe('a monthly plan starting off the 1st', () => {
  it('pays a prorated stretch to the next 1st, then the full fee on every 1st', () => {
    const rows = feeCharges(plan());
    expect(rows[0].date).toBe(START);
    expect(rows[0].l.proration).toEqual({ prorated_days: 14, period_days: 31 });
    expect(rows[0].l.actual_charge).toBe(14);
    expect(rows[1]).toMatchObject({ date: '2026-12-01', l: { actual_charge: 31 } });
    expect(rows[2]).toMatchObject({ date: '2027-01-01', l: { actual_charge: 31 } });
  });

  it('adds the whole Pre-paid Duration to the first payment, and the stretch consumes no pre-paid month', () => {
    const rows = feeCharges(plan({ paid: 3, prepaid: 3 }));
    expect(rows[0].date).toBe(START);
    expect(rows[0].l.actual_charge).toBe(14 + 93);
    expect(rows[0].l.prepaid_periods).toBe(3);
    // Dec, Jan and Feb were paid up front; regular billing resumes on 1 March.
    const charged = rows.slice(1).filter((r) => r.l.actual_charge > 0);
    expect(charged[0]).toMatchObject({ date: '2027-03-01', l: { actual_charge: 31 } });
    expect(rows.some((r) => ['2026-12-01', '2027-01-01', '2027-02-01'].includes(r.date) && r.l.actual_charge > 0)).toBe(false);
  });

  it('counts a Free Period from the first 1st, so the stretch before it is free too', () => {
    const rows = feeCharges(plan({ free: 1 }));
    expect(rows[0].l.actual_charge).toBe(0);
    const charged = rows.filter((r) => r.l.actual_charge > 0);
    expect(charged[0]).toMatchObject({ date: '2027-01-01', l: { actual_charge: 31 } });
  });

  it('is not prorated when it starts on the 1st', () => {
    const rows = feeCharges({ ...plan(), startsAt: '2026-12-01', alignTo: '2026-12-01' });
    expect(rows[0]).toMatchObject({ date: '2026-12-01', l: { actual_charge: 31 } });
    expect(rows[0].l.proration ?? null).toBeNull();
  });
});
