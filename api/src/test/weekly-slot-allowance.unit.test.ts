import { describe, expect, it } from 'vitest';
import { weeklyAllowanceByService, weeklyAllowanceOfLine } from '../domain/weeklySlotAllowance';

// #3090 stage 4 (§5): sessions per week a member's plans include for a Professional Service.
describe('weeklySlotAllowance', () => {
  it('reads a weekly line as its quantity and spreads longer periods over their weeks', () => {
    expect(weeklyAllowanceOfLine(2, 'week')).toBe(2);
    expect(weeklyAllowanceOfLine(8, 'four_weeks')).toBe(2);
    expect(weeklyAllowanceOfLine(52, 'year')).toBe(1);
    expect(weeklyAllowanceOfLine(13, 'month')).toBeCloseTo(3, 5);
  });

  it('has no weekly allowance for a one-time or unset Frequency', () => {
    expect(weeklyAllowanceOfLine(10, 'once')).toBeNull();
    expect(weeklyAllowanceOfLine(10, null)).toBeNull();
    expect(weeklyAllowanceOfLine(10, 'per_session')).toBeNull();
  });

  it('adds the renewing lines of one service and leaves out a service with none', () => {
    const map = weeklyAllowanceByService([
      { professional_service_id: 1, quantity: 1, frequency: 'week' },
      { professional_service_id: 1, quantity: 4, frequency: 'four_weeks' },
      { professional_service_id: 1, quantity: 10, frequency: 'once' },
      { professional_service_id: 2, quantity: 5, frequency: null },
      { professional_service_id: 3, quantity: 8, frequency: 'month' },
    ]);
    expect(map.get(1)).toBe(2);
    expect(map.has(2)).toBe(false);
    expect(map.get(3)).toBe(1.85);
  });
});
