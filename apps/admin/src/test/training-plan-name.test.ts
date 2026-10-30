import { describe, expect, it } from 'vitest';
import { displayTrainingPlanName } from '../lib/trainingPlanName';

describe('displayTrainingPlanName (#2159)', () => {
  it('strips the open-ended and the closed version suffix', () => {
    expect(displayTrainingPlanName('TP1 - Xavi [2026-10-31 - Open End]')).toBe('TP1 - Xavi');
    expect(displayTrainingPlanName('TP1 - Xavi [2026-10-31 - Open Ended]')).toBe('TP1 - Xavi');
    expect(displayTrainingPlanName('Strength [2026-01-01 - 2026-02-01]')).toBe('Strength');
  });
  it('leaves other brackets alone', () => {
    expect(displayTrainingPlanName('Plan [draft] x')).toBe('Plan [draft] x');
  });
});
