import { db } from './db';
import { deliverPushNotifications, type PushTarget } from './push';

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
  | 'recurring_booking_skipped'
  /**
   * #979: a cancelled event put back on the calendar, with the member's
   * booking still on it. Deliberately not `booking_confirmed` — the member
   * made no new booking (§6, §11), and sending the booking alert would tell
   * them they had just booked something they never touched.
   */
  | 'event_reactivated'
  /**
   * #980 stage 2: the occurrence's waiting list was disabled, so the member is
   * no longer on it (§4/§5). Deliberately not `event_cancelled` — the class is
   * still running and the member never held a booking, so the booking
   * vocabulary would tell them something false.
   */
  | 'waitlist_closed'
  /**
   * #980 stage 2: staff took this one member off the waiting list, with the
   * list itself still there. A different fact from `waitlist_closed`, and the
   * Alerts page words the two differently.
   */
  | 'waitlist_removed';

export interface NotificationPayload {
  title: string;
  starts_at?: string;
  [key: string]: unknown;
}

/**
 * #1072 (mobile app WP1): the push copy of a notification.
 *
 * Every writer below ends here, and all of it is deliberately *after* the
 * insert and never awaited. The durable fact is the `member_notifications` row
 * the Members App reads; a push is a courtesy copy of it, so a deployment with
 * no FCM credentials, an unreachable Firebase or a member with no registered
 * device all cost the push and nothing else — never the row, and never the
 * request that wrote it. `deliverPushNotifications()` returns immediately (and
 * does not touch the database at all) when this deployment has no credentials,
 * which is what keeps it inert in tests and in local development.
 */
function push(gymId: string, targets: PushTarget[]): void {
  deliverPushNotifications(gymId, targets);
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
  ).then(
    () => push(gymId, [{ memberId, type, entityType, entityId, payload }]),
    (err: any) => console.error('[notifications] insert failed:', err),
  );
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
  // #1072: the push copy is still fire-and-forget even though the insert is
  // awaited — the caller is a nightly job that reports how many alerts it
  // raised, and that count is about the rows, not about Firebase.
  push(gymId, rows.map((r) => ({
    memberId: r.memberId, type: r.type, entityType: r.entityType, entityId: r.entityId, payload: r.payload,
  })));
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
  ).then(
    () => push(gymId, memberIds.map((memberId) => ({ memberId, type, entityType, entityId, payload }))),
    (err: any) => console.error('[notifications] bulk insert failed:', err),
  );
}
