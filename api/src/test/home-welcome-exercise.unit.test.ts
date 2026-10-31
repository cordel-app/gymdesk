import { describe, it, expect } from 'vitest';
import { welcomeExerciseIndex } from '../api/home-dashboard';

describe('welcomeExerciseIndex (#2171)', () => {
  const noon = (d: string) => new Date(`${d}T12:00:00Z`);
  it('is stable within a gym-local day', () => {
    expect(welcomeExerciseIndex(7, 'Europe/Madrid', new Date('2026-10-31T08:00:00Z')))
      .toBe(welcomeExerciseIndex(7, 'Europe/Madrid', new Date('2026-10-31T20:00:00Z')));
  });
  it('moves to a different exercise on the next day when there are several', () => {
    const a = welcomeExerciseIndex(5, 'Europe/Madrid', noon('2026-10-31'));
    const b = welcomeExerciseIndex(5, 'Europe/Madrid', noon('2026-11-01'));
    expect(b).toBe((a + 1) % 5);
  });
  it('follows the gym time zone at the day boundary', () => {
    const t = new Date('2026-10-31T23:30:00Z'); // already Nov 1 in Madrid
    expect(welcomeExerciseIndex(9, 'Europe/Madrid', t)).not.toBe(welcomeExerciseIndex(9, 'UTC', t));
  });
  it('handles no candidates', () => {
    expect(welcomeExerciseIndex(0, 'UTC')).toBe(0);
  });
});
