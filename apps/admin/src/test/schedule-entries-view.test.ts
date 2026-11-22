import { describe, it, expect } from 'vitest';
import {
  entrySlotOptions, entrySlotKey, toggleEntryMember, updateEntryBody, entryErrorKey,
} from '../app/[locale]/members/scheduleEntriesView';

const slot = (weekday: number, start: string, extra: Record<string, unknown> = {}) => ({
  weekday, start_time: start, end_time: '23:00', activity_type_id: 1, professional_service_id: 2,
  center_id: null, professional_service_name: 'PT', activity_type_name: 'Act', center_name: null, ...extra,
});

describe('schedule entries view', () => {
  it('lists every offered slot once, by weekday then time, keeping the current one', () => {
    const days = [{ slots: [slot(3, '12:00'), slot(1, '10:00')] }, { slots: [slot(1, '10:00')] }];
    const gone = slot(5, '09:00');
    const options = entrySlotOptions(days, gone);
    expect(options.map(entrySlotKey)).toEqual([slot(1, '10:00'), slot(3, '12:00'), gone].map(entrySlotKey));
  });

  it('toggles members and sends only the identity fields', () => {
    expect(toggleEntryMember([1, 2], 2)).toEqual([1]);
    expect(toggleEntryMember([1], 3)).toEqual([1, 3]);
    const body = updateEntryBody(slot(1, '10:00'), slot(3, '12:00'), [1]);
    expect(Object.keys(body.slot).sort()).toEqual(
      ['activity_type_id', 'center_id', 'end_time', 'professional_service_id', 'start_time', 'weekday'],
    );
  });

  it('words the API refusals it knows', () => {
    expect(entryErrorKey('participants_below_minimum')).toBe('pt_entries_error_minimum');
    expect(entryErrorKey('other')).toBeNull();
  });
});
