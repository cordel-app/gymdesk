import { db } from './db';

export type NotificationType =
  | 'booking_confirmed'
  | 'waitlist_joined'
  | 'promoted_from_waitlist'
  | 'event_cancelled'
  | 'event_updated'
  | 'booking_reminder_24h'
  | 'booking_reminder_1h'
  | 'shared_training_approved'
  | 'shared_training_rejected';

export interface NotificationPayload {
  title: string;
  starts_at?: string;
  [key: string]: unknown;
}

export function sendNotification(
  gymId: string,
  memberId: number,
  type: NotificationType,
  entityType: 'session' | 'event' | null,
  entityId: number | null,
  payload: NotificationPayload,
): void {
  db.query(
    `INSERT INTO member_notifications (gym_id, member_id, type, entity_type, entity_id, payload)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [gymId, memberId, type, entityType, entityId, JSON.stringify(payload)],
  ).catch((err: any) => console.error('[notifications] insert failed:', err));
}

export function sendBulkNotification(
  gymId: string,
  memberIds: number[],
  type: NotificationType,
  entityType: 'session' | 'event' | null,
  entityId: number | null,
  payload: NotificationPayload,
): void {
  if (memberIds.length === 0) return;
  const placeholders = memberIds.map(() => '(?, ?, ?, ?, ?, ?)').join(', ');
  const params = memberIds.flatMap((id) => [gymId, id, type, entityType, entityId, JSON.stringify(payload)]);
  db.query(
    `INSERT INTO member_notifications (gym_id, member_id, type, entity_type, entity_id, payload) VALUES ${placeholders}`,
    params,
  ).catch((err: any) => console.error('[notifications] bulk insert failed:', err));
}
