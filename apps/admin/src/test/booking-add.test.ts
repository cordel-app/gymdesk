import { describe, it, expect } from 'vitest';
import { addAttendeeBody, classifyAddRefusal, isClassFull, serviceOptionsFrom } from '../lib/bookingAdd';

// #3096: staff add an attendee from Home's Start dialog with the Calendar's rules.
describe('bookingAdd', () => {
  it('sends only what staff confirmed', () => {
    expect(addAttendeeBody({ memberId: 7, sessionId: 3 })).toEqual({ member_id: 7, class_session_id: 3 });
    expect(addAttendeeBody({ memberId: 7, sessionId: 3, force: true, override: true, serviceId: 9 }))
      .toEqual({ member_id: 7, class_session_id: 3, force: true, override_eligibility: true, professional_service_id: 9 });
  });

  it('asks which service when the API names several', () => {
    const err = { message: 'x', body: { code: 'professional_service_selection_required', professional_services: [{ id: 1, name: 'PT' }, { id: 2, name: 'Duo' }, { id: 1, name: 'PT' }] } };
    expect(classifyAddRefusal(err)).toEqual({ kind: 'choose_service', services: [{ id: 1, name: 'PT' }, { id: 2, name: 'Duo' }] });
  });

  it('offers an override for an eligibility refusal, and a plain error otherwise', () => {
    expect(classifyAddRefusal({ message: 'No sessions', body: { code: 'professional_service_required', professional_services: [{ id: 4, name: 'PT' }] } }))
      .toEqual({ kind: 'override', code: 'professional_service_required', message: 'No sessions', services: [{ id: 4, name: 'PT' }] });
    expect(classifyAddRefusal({ message: 'Not covered', body: { code: 'center_not_covered' } }))
      .toEqual({ kind: 'override', code: 'center_not_covered', message: 'Not covered', services: [] });
    expect(classifyAddRefusal({ message: 'Full', body: { code: 'session_full_waitlist_not_open' } })).toEqual({ kind: 'error', message: 'Full' });
    expect(classifyAddRefusal(undefined)).toEqual({ kind: 'error', message: null });
  });

  it('ignores malformed service entries', () => {
    expect(serviceOptionsFrom({ body: { professional_services: [{ id: 'x', name: 'A' }, { id: 2, name: ' ' }, { id: 3, name: 'C' }] } })).toEqual([{ id: 3, name: 'C' }]);
  });

  it('reads capacity from the booked rows', () => {
    expect(isClassFull([])).toBe(false);
    expect(isClassFull([{ effective_capacity: 2 }])).toBe(false);
    expect(isClassFull([{ effective_capacity: '2' }, { effective_capacity: '2' }])).toBe(true);
  });
});
