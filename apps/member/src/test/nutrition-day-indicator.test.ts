import { describe, it, expect } from 'vitest';
import { dayIndicatorBackground } from '../lib/nutritionDayIndicator';

const colors = {
  success: 'G', error: 'R',
  status: { completed: 'G', partial: 'P', pending: 'R', scheduled: 'Y', rest: 'N' },
};

describe('dayIndicatorBackground (#3489)', () => {
  it('fills the circle green in proportion to the day score', () => {
    expect(dayIndicatorBackground('partial', 50, colors)).toBe('conic-gradient(G 0% 50%, R 50% 100%)');
    expect(dayIndicatorBackground('partial', 75, colors)).toBe('conic-gradient(G 0% 75%, R 75% 100%)');
    expect(dayIndicatorBackground('pending', 25, colors)).toBe('conic-gradient(G 0% 25%, R 25% 100%)');
  });
  it('is fully green at 100% and has no green at 0%', () => {
    expect(dayIndicatorBackground('completed', 100, colors)).toBe('G');
    expect(dayIndicatorBackground('pending', 0, colors)).toBe('R');
  });
  it('keeps the status colour for a day with no score (rest, scheduled)', () => {
    expect(dayIndicatorBackground('rest', null, colors)).toBe('N');
    expect(dayIndicatorBackground('scheduled', null, colors)).toBe('Y');
    expect(dayIndicatorBackground('pending', undefined, colors)).toBe('R');
  });
});
