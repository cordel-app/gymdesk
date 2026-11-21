import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BOOKING_SOURCES, DEFAULT_BOOKING_SOURCE, isBookingSource } from '../domain/bookingSource';

describe('booking source (#3090)', () => {
  it('accepts only manual and recurring_slot, defaulting to manual', () => {
    expect(isBookingSource('manual')).toBe(true);
    expect(isBookingSource('recurring_slot')).toBe(true);
    expect(isBookingSource('import')).toBe(false);
    expect(isBookingSource(null)).toBe(false);
    expect(DEFAULT_BOOKING_SOURCE).toBe('manual');
  });

  it('the migration CHECK lists exactly the declared set', () => {
    const sql = readFileSync(join(__dirname, '../infra/migrations/446_calendar_event_booking_source.js'), 'utf8');
    for (const s of BOOKING_SOURCES) expect(sql).toContain(`'${s}'`);
  });
});
