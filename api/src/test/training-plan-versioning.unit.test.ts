import { describe, it, expect } from 'vitest';
import { gymToday } from '../domain/workoutProgress';
import { baseTrainingPlanName, isSameDayEdit, nextDay, previousDay, versionedTrainingPlanName } from '../domain/trainingPlanVersioning';

describe('training plan version names (#1969)', () => {
  it('names the previous and current versions', () => {
    expect(versionedTrainingPlanName('Strength', '2026-01-01', '2026-02-01')).toBe('Strength [2026-01-01 - 2026-02-01]');
    expect(versionedTrainingPlanName('Strength', '2026-02-02', null)).toBe('Strength [2026-02-02 - Open End]');
  });
  it('does not accumulate suffixes when edited again', () => {
    expect(versionedTrainingPlanName('Strength [2026-02-02 - Open End]', '2026-03-04', null)).toBe('Strength [2026-03-04 - Open End]');
    expect(baseTrainingPlanName('Strength [2026-01-01 - 2026-02-01]')).toBe('Strength');
    expect(baseTrainingPlanName('Plan [draft] x')).toBe('Plan [draft] x');
  });
  it('computes tomorrow across month and year ends', () => {
    expect(nextDay('2026-12-31')).toBe('2027-01-01');
    expect(nextDay('2028-02-28')).toBe('2028-02-29');
  });

  it('computes yesterday across month and year starts', () => {
    expect(previousDay('2027-01-01')).toBe('2026-12-31');
    expect(previousDay('2028-03-01')).toBe('2028-02-29');
  });
});

describe('same-day edit rule (#3409)', () => {
  it('compares calendar dates, whatever shape the DATE column comes back in', () => {
    expect(isSameDayEdit('2026-11-25', '2026-11-25')).toBe(true);
    expect(isSameDayEdit('2026-11-25T00:00:00.000Z', '2026-11-25')).toBe(true);
    expect(isSameDayEdit(new Date('2026-11-25T00:00:00Z'), '2026-11-25')).toBe(true);
  });
  it('is false the day before, the day after and without a start date', () => {
    expect(isSameDayEdit('2026-11-24', '2026-11-25')).toBe(false);
    expect(isSameDayEdit('2026-11-26', '2026-11-25')).toBe(false);
    expect(isSameDayEdit('2026-12-31', '2027-01-01')).toBe(false);
    expect(isSameDayEdit(null, '2026-11-25')).toBe(false);
    expect(isSameDayEdit('', '2026-11-25')).toBe(false);
  });
  it('takes today from the gym\'s zone: 23:30 UTC on the 24th is already the 25th in Madrid', () => {
    const today = gymToday(new Date('2026-11-24T23:30:00Z'), 'Europe/Madrid');
    expect(today).toBe('2026-11-25');
    expect(isSameDayEdit('2026-11-25', today)).toBe(true);
    expect(isSameDayEdit('2026-11-24', today)).toBe(false);
  });
});
