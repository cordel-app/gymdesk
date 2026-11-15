import { describe, it, expect } from 'vitest';
import { calendarEventServiceNames } from '../lib/calendarEventServices';

describe('calendarEventServiceNames (#2849)', () => {
  it('lists every service of the occurrence, in the API order', () => {
    expect(calendarEventServiceNames({
      services: [{ id: 2, name: 'Duo PT' }, { id: 1, name: 'Personal Training' }],
    })).toEqual(['Duo PT', 'Personal Training']);
  });

  it('falls back to the effective eligible list when no capacity views are attached', () => {
    expect(calendarEventServiceNames({
      eligible_professional_services: [{ id: 1, name: 'Nutrition' }],
    })).toEqual(['Nutrition']);
  });

  it('answers no services for an event that offers none, so its capacity stays', () => {
    expect(calendarEventServiceNames({ services: [], eligible_professional_services: [] })).toEqual([]);
    expect(calendarEventServiceNames({})).toEqual([]);
    expect(calendarEventServiceNames(null)).toEqual([]);
  });

  it('drops blank names and lists a service once', () => {
    expect(calendarEventServiceNames({
      services: [{ id: 1, name: ' PT ' }, { id: 1, name: 'PT' }, { id: 3, name: '  ' }, { id: 4, name: null }],
    })).toEqual(['PT']);
  });
});
