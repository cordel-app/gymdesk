import { describe, it, expect } from 'vitest';
import { overWeeklyAllowance } from '../app/[locale]/members/slotWeeklyAllowance';

// #3090 stage 4: warn when the selected weekly slots exceed the plan's weekly sessions.
describe('overWeeklyAllowance', () => {
  const services = [
    { professional_service_id: 1, name: 'PT', included_per_week: 2 },
    { professional_service_id: 2, name: 'Physio', included_per_week: null },
    { professional_service_id: 3, name: 'Nutrition', included_per_week: 1.85 },
  ];
  const slot = (id: number) => ({ professional_service_id: id });

  it('reports nothing at or under the allowance', () => {
    expect(overWeeklyAllowance([slot(1), slot(1), slot(3)], services)).toEqual([]);
  });

  it('reports a service whose selected slots exceed it', () => {
    expect(overWeeklyAllowance([slot(1), slot(1), slot(1), slot(3), slot(3)], services)).toEqual([
      { professional_service_id: 1, name: 'PT', scheduled: 3, included: 2 },
      { professional_service_id: 3, name: 'Nutrition', scheduled: 2, included: 1.85 },
    ]);
  });

  it('never warns for a service with no weekly allowance', () => {
    expect(overWeeklyAllowance([slot(2), slot(2), slot(2), slot(2)], services)).toEqual([]);
  });
});
