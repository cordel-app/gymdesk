import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const APP = join(__dirname, '..', 'app', '[locale]', 'calendar');
const panel = readFileSync(join(APP, 'ClassSessionDetailPanel.tsx'), 'utf-8');
const image = readFileSync(join(APP, 'EventImageControl.tsx'), 'utf-8');
const LOCALES = join(__dirname, '..', '..', 'locales', 'base');

describe('Calendar event details (#1382)', () => {
  it('hides Remove once the event has started, for enrolled and waiting members alike', () => {
    expect(panel).toContain('const hasStarted = new Date(session.starts_at).getTime() <= Date.now()');
    const guarded = panel.match(/canWrite && !isCancelled && !hasStarted && \(\s*<button\s*onClick=\{\(\) => setRemovingBooking\(b\)\}/g) ?? [];
    expect(guarded).toHaveLength(2);
  });

  it('records attendance per attendee and keeps unconfirmed distinct from absent', () => {
    expect(panel).toContain('/bookings/${b.id}/attendance');
    expect(panel).toContain("b.attendance_status === 'pending' ? 'unconfirmed'");
    // The saved booking replaces only its own row.
    expect(panel).toMatch(/r\.id === b\.id \? \{ \.\.\.r, \.\.\.updated \}/);
  });

  it('offers Refund Balance only for an explicitly absent, unreturned consumption', () => {
    expect(panel).toMatch(/b\.attendance_status === 'absent' && !!b\.service_consumed && !b\.service_returned/);
    expect(panel).toContain('/bookings/${b.id}/refund-balance');
  });

  it('completes without a second prompt', () => {
    expect(panel).toMatch(/if \(unconfirmedCount > 0\) setShowCompleteConfirm\(true\);\s*else void handleMarkCompleted\(\);/);
    expect(panel).toContain("t('complete_event')");
  });

  it('draws the event image under the title and writes only the event\'s own override', () => {
    expect(panel).toContain('<EventImageControl');
    expect(panel).toContain('effectiveUrl={session.effective_image_url}');
    expect(image).toContain('/class-sessions/${sessionId}/image');
    expect(image).not.toContain('/activity-types/');
  });

  it('has every new key in every locale', () => {
    const keys = [
      'event_image_upload', 'event_image_remove', 'event_image_none', 'attendance_unconfirmed',
      'attendance_present', 'attendance_absent', 'attendance_mark_present', 'attendance_mark_absent',
      'refund_balance', 'balance_refunded', 'complete_unconfirmed_title', 'complete_event',
    ];
    for (const code of ['en', 'es', 'ca']) {
      const messages = JSON.parse(readFileSync(join(LOCALES, `${code}.json`), 'utf-8'));
      for (const key of keys) expect(messages.calendar[key], `${code}.calendar.${key}`).toBeTypeOf('string');
    }
  });
});
