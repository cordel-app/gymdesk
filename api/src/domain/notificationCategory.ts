/**
 * #1391: the Members App's Alerts page files every alert under one of two
 * categories — **Staff** (a person at the gym wrote it) or **Auto** (the
 * platform raised it). It is derived from the type, never stored: a second
 * column would be a second record of a fact the type already carries, and
 * every existing row would need a backfill.
 */
import type { NotificationType } from '../infra/notifications';

export type NotificationCategory = 'staff' | 'auto';

/** Types that are written by a person. Everything else is Auto. */
export const STAFF_NOTIFICATION_TYPES: readonly NotificationType[] = ['staff_message'];

export function notificationCategory(type: string): NotificationCategory {
  return (STAFF_NOTIFICATION_TYPES as readonly string[]).includes(type) ? 'staff' : 'auto';
}
