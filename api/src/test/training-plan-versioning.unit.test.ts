import { describe, it, expect } from 'vitest';
import { baseTrainingPlanName, nextDay, previousDay, versionedTrainingPlanName } from '../domain/trainingPlanVersioning';

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
