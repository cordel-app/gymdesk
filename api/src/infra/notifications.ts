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
  | 'shared_training_rejected'
  /** #647 stage 4: a recurring Personal Training date the nightly job could not book. */
  | 'recurring_booking_skipped';

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

/** One row for `recordNotifications`. */
export interface NotificationRow {
  memberId: number;
  type: NotificationType;
  entityType: 'session' | 'event' | null;
  entityId: number | null;
  payload: NotificationPayload;
}

/**
 * Insert notifications for one gym and *wait* for the result.
 *
 * The fire-and-forget helpers above are right for a request path, where the
 * Member is watching a booking confirm and a notification row is a side
 * effect. #647 stage 4's nightly job is the opposite case: nobody is watching,
 * the run reports how many alerts it raised, and a silently swallowed insert
 * would make that count a lie — and, because the job dedupes against the rows
 * it previously wrote, a lost insert means the same alert is attempted again
 * every night.
 *
 * Returns the number of rows written.
 */
export async function recordNotifications(gymId: string, rows: NotificationRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const placeholders = rows.map(() => '(?, ?, ?, ?, ?, ?)').join(', ');
  const params = rows.flatMap((r) => [
    gymId, r.memberId, r.type, r.entityType, r.entityId, JSON.stringify(r.payload),
  ]);
  const { rowCount } = await db.query(
    `INSERT INTO member_notifications (gym_id, member_id, type, entity_type, entity_id, payload)
     VALUES ${placeholders}`,
    params,
  );
  return rowCount;
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
