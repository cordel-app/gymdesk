import { describe, it, expect } from 'vitest';
import { planCoversDate, plansOnDate } from '../lib/trainingPlanDates';
import { dayStatus } from '../lib/trainingDayStatus';

const plan = { start_date: '2026-09-23T00:00:00.000Z', end_date: '2026-10-21T00:00:00.000Z' };

describe('planCoversDate (#1956)', () => {
  it('is false the day before the Start Date', () => expect(planCoversDate(plan, '2026-09-22')).toBe(false));
  it('is true on the Start Date, inside the range and on the End Date', () => {
    expect(planCoversDate(plan, '2026-09-23')).toBe(true);
    expect(planCoversDate(plan, '2026-10-05')).toBe(true);
    expect(planCoversDate(plan, '2026-10-21')).toBe(true);
  });
  it('is false the day after the End Date and later', () => {
    expect(planCoversDate(plan, '2026-10-22')).toBe(false);
    expect(planCoversDate(plan, '2027-01-01')).toBe(false);
  });
  it('treats a missing bound as open-ended and accepts plain dates', () => {
    expect(planCoversDate({ start_date: null, end_date: null }, '2030-01-01')).toBe(true);
    expect(planCoversDate({ start_date: '2026-10-01', end_date: null }, '2030-01-01')).toBe(true);
    expect(planCoversDate({ start_date: '2026-10-01', end_date: '2026-10-02' }, '2026-10-03')).toBe(false);
  });
  it('keeps only the plans valid that day, so a future day after the End Date is a rest day', () => {
    const plans = [{ ...plan, workouts: [{ scheduled_weekday: 4, blocks: [{ id: 1 }] }] }];
    const day = '2026-10-29'; // Thursday, after the End Date
    const workouts = plansOnDate(plans, day).flatMap((p) => p.workouts);
    expect(dayStatus(day, 4, '2026-10-21', workouts, [])).toBe('rest');
    const inside = plansOnDate(plans, '2026-10-15').flatMap((p) => p.workouts);
    expect(dayStatus('2026-10-15', 4, '2026-10-21', inside, [])).toBe('pending');
  });
});
