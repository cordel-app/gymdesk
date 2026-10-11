// #1391 — the pure halves of staff communications: the body judgement, the
// Staff/Auto category, the permission override and the push rule.

import { describe, expect, it, vi } from 'vitest';
import {
  COMMUNICATION_MESSAGE_MAX,
  COMMUNICATION_TITLE_MAX,
  parseCommunicationInput,
  STAFF_COMMUNICATIONS_FEATURE,
} from '../domain/staffCommunication';
import { notificationCategory } from '../domain/notificationCategory';
import { canWriteFeature, canAccessFeature } from '../infra/permissions';

describe('parseCommunicationInput', () => {
  it('trims and accepts a valid body', () => {
    expect(parseCommunicationInput({ title: '  Hi ', message: ' Room changed ' }))
      .toEqual({ ok: true, title: 'Hi', message: 'Room changed' });
  });
  it('rejects missing, blank and non-string values', () => {
    expect(parseCommunicationInput(undefined).ok).toBe(false);
    expect(parseCommunicationInput({ title: 'a' }).ok).toBe(false);
    expect(parseCommunicationInput({ title: '  ', message: 'x' }).ok).toBe(false);
    expect(parseCommunicationInput({ title: 'x', message: '   ' }).ok).toBe(false);
    expect(parseCommunicationInput({ title: 5, message: 'x' }).ok).toBe(false);
  });
  it('enforces the length caps', () => {
    expect(parseCommunicationInput({ title: 'a'.repeat(COMMUNICATION_TITLE_MAX), message: 'x' }).ok).toBe(true);
    expect(parseCommunicationInput({ title: 'a'.repeat(COMMUNICATION_TITLE_MAX + 1), message: 'x' }).ok).toBe(false);
    expect(parseCommunicationInput({ title: 'x', message: 'a'.repeat(COMMUNICATION_MESSAGE_MAX + 1) }).ok).toBe(false);
  });
});

describe('notificationCategory', () => {
  it('files staff_message under staff and everything else under auto', () => {
    expect(notificationCategory('staff_message')).toBe('staff');
    for (const t of ['booking_confirmed', 'event_cancelled', 'booking_reminder_2h', 'waitlist_closed', 'unknown']) {
      expect(notificationCategory(t)).toBe('auto');
    }
  });
});

describe('who may send (feature-level permission)', () => {
  const k = STAFF_COMMUNICATIONS_FEATURE;
  it('allows Admin, Trainers, Front Desk and Nutritionist', () => {
    for (const r of ['admin', 'trainer_performance', 'trainer_perf_nutrition', 'front_desk', 'nutritionist'] as const) {
      expect(canWriteFeature(r, 'CALENDAR', k), r).toBe(true);
    }
  });
  it('does not grant anyone else', () => {
    expect(canWriteFeature('accountant', 'CALENDAR', k)).toBe(false);
    expect(canAccessFeature('accountant', 'CALENDAR', k)).toBe(false);
    expect(canWriteFeature('member', 'CALENDAR', k)).toBe(false);
  });
});

describe('push is the writers\' common rule', () => {
  it('every writer hands its alert to deliverPushNotifications', async () => {
    vi.resetModules();
    const deliver = vi.fn();
    vi.doMock('../infra/push', () => ({ deliverPushNotifications: deliver }));
    vi.doMock('../infra/db', () => ({ db: { query: vi.fn().mockResolvedValue({ rowCount: 1 }) } }));
    const n = await import('../infra/notifications');
    n.sendNotification('g', 1, 'staff_message', 'session', 2, { title: 't' });
    n.sendBulkNotification('g', [1, 2], 'event_cancelled', 'session', 2, { title: 't' });
    await n.recordNotifications('g', [{ memberId: 1, type: 'staff_message', entityType: 'session', entityId: 2, payload: { title: 't' } }]);
    await new Promise((r) => setTimeout(r, 0));
    expect(deliver).toHaveBeenCalledTimes(3);
    vi.doUnmock('../infra/push');
    vi.doUnmock('../infra/db');
  });
});
