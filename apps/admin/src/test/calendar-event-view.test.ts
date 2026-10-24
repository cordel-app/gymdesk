import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  customEventView, eventCapabilities, eventDetailRows, eventSpan, eventTimeLines, sessionEventView,
  type EventTimeFormat,
} from '../app/[locale]/calendar/calendarEventView';
import type { CalendarEventForm } from '../app/[locale]/calendar/CalendarEventModal';

// #1891 stage 3 — one representation behind both calendar detail panels.
const fmt: EventTimeFormat = {
  date: (v) => `D(${v.slice(0, 10)})`,
  time: (v) => `T(${v.slice(11, 16)})`,
  allDay: 'All day',
};

const form = (over: Partial<CalendarEventForm> = {}): CalendarEventForm => ({
  title: 'Open day', activity_type_id: '', space_id: '', center_id: '', trainer_membership_id: '',
  professional_service_id: '', color: '', starts_at: '2026-10-24T10:00', ends_at: '2026-10-24T11:30',
  all_day: false, description: '', status: 'scheduled', ...over,
});

const lookups = {
  activityTypes: [{ id: 3, name: 'Yoga' }],
  spaces: [{ id: 4, name: 'Room A' }],
  centers: [{ id: 5, name: 'Downtown' }],
  trainers: [{ gym_membership_id: 6, name: 'Ana' }],
  professionalServices: [{ id: 7, name: 'Physio' }],
};

describe('custom event view', () => {
  it('resolves the stored ids through the page lookups, including the Professional Service', () => {
    const v = customEventView(form({
      activity_type_id: '3', space_id: '4', center_id: '5', trainer_membership_id: '6', professional_service_id: '7',
    }), lookups);
    expect(v).toMatchObject({
      kind: 'custom', activity: 'Yoga', space: 'Room A', center: 'Downtown', trainer: 'Ana',
      professionalService: 'Physio', capacity: null,
    });
    expect(eventDetailRows(v).map((r) => [r.key, r.value])).toEqual([
      ['activity', 'Yoga'], ['professional_service', 'Physio'], ['trainer', 'Ana'], ['space', 'Room A'], ['center', 'Downtown'],
    ]);
  });

  it('keeps unset rows as null (rendered as —) and omits the center when there is none', () => {
    const rows = eventDetailRows(customEventView(form(), lookups));
    expect(rows.map((r) => r.key)).toEqual(['activity', 'professional_service', 'trainer', 'space']);
    expect(rows.every((r) => r.value === null)).toBe(true);
  });
});

describe('session event view', () => {
  const v = sessionEventView({
    class_type_name: 'Spinning', starts_at: '2026-10-24T09:00:00.000Z', ends_at: '2026-10-24T10:00:00.000Z',
    professional_service_name: 'PT', trainer_name: 'Ana', effective_trainer_name: 'Bea', space_name: 'Room B',
    effective_capacity: 12, status: 'scheduled', execution_status: 'not_used',
  }, 5);

  it('reports capacity, the covering trainer and the derived execution status', () => {
    expect(v.capacity).toEqual({ enrolled: 5, total: 12 });
    expect(v.status).toBe('not_used');
    expect(eventDetailRows(v).map((r) => r.key)).toContain('covering_trainer');
    expect(eventDetailRows(v).map((r) => r.key)).not.toContain('activity');
  });

  it('hides the covering trainer when it is the scheduled one', () => {
    expect(eventDetailRows({ ...v, coveringTrainer: 'Ana' }).map((r) => r.key)).not.toContain('covering_trainer');
  });
});

describe('capabilities', () => {
  it('enrolment, waiting list, attendance and change time are session-only', () => {
    expect(eventCapabilities('session')).toEqual({
      enrollment: true, waitingList: true, attendance: true, changeTime: true, capacity: true,
    });
    expect(Object.values(eventCapabilities('custom')).every((x) => x === false)).toBe(true);
  });
});

describe('time lines', () => {
  it('timed single-day', () => {
    const v = customEventView(form(), lookups);
    expect(eventSpan(v)).toBe('timed');
    expect(eventTimeLines(v, fmt)).toEqual(['D(2026-10-24)', 'T(10:00) – T(11:30)']);
  });

  it('all-day single-day', () => {
    const v = customEventView(form({ all_day: true, starts_at: '2026-10-24', ends_at: '2026-10-24' }), lookups);
    expect(eventSpan(v)).toBe('all_day');
    expect(eventTimeLines(v, fmt)).toEqual(['D(2026-10-24)', 'All day']);
  });

  it('all-day multi-day', () => {
    const v = customEventView(form({ all_day: true, starts_at: '2026-10-24', ends_at: '2026-10-26' }), lookups);
    expect(eventSpan(v)).toBe('multi_day');
    expect(eventTimeLines(v, fmt)).toEqual(['D(2026-10-24) – D(2026-10-26)', 'All day']);
  });

  it('timed multi-day shows both ends', () => {
    const v = customEventView(form({ starts_at: '2026-10-24T22:00', ends_at: '2026-10-25T02:00' }), lookups);
    expect(eventSpan(v)).toBe('multi_day');
    expect(eventTimeLines(v, fmt)).toEqual(['D(2026-10-24) T(22:00)', 'D(2026-10-25) T(02:00)']);
  });
});

describe('both panels render the shared layout', () => {
  const DIR = join(__dirname, '..', 'app', '[locale]', 'calendar');
  const read = (f: string) => readFileSync(join(DIR, f), 'utf8');

  it('the session panel and the custom panel use the shared header and info card', () => {
    for (const f of ['ClassSessionDetailPanel.tsx', 'EventDetailsPanel.tsx']) {
      const src = read(f);
      expect(src).toContain('CalendarEventHeader');
      expect(src).toContain('CalendarEventInfoCard');
    }
  });

  it('the session panel keeps no private DetailRow', () => {
    expect(read('ClassSessionDetailPanel.tsx')).not.toMatch(/^function DetailRow/m);
  });

  it('the custom panel offers no enrolment or waiting list', () => {
    expect(read('EventDetailsPanel.tsx')).not.toMatch(/waitlist|Enrolled members/i);
  });
});
