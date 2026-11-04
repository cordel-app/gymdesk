import type { Tx } from '../infra/db';
import { recordNotifications } from '../infra/notifications';

/**
 * #2324 — what happens to an Activity's future events when it is deactivated
 * or deleted.
 *
 * Future events (starts_at in the future, not deleted) of the Activity:
 *  - with no booking history at all (only waiting-list entries, if anything)
 *    are hard deleted, their waiting-list rows with them;
 *  - with a booked participant — or any booking that carries a Professional
 *    Service consumption, which a hard delete would cascade away — are marked
 *    `cancelled`, keep every booking row, and have their waiting list released
 *    (`waitlisted` → `cancelled`, as `emptyWaitlistQueue()` does).
 * Past events are untouched. No consumption, charge or billing row is written.
 *
 * Returns the members to alert: everyone booked or waitlisted on a future
 * event, once. The caller sends the alert after the transaction commits.
 */
export interface DiscontinuationResult {
  deletedEvents: number;
  cancelledEvents: number;
  memberIds: number[];
}

const FUTURE = `ce.activity_type_id = ? AND ce.gym_id = ? AND ce.starts_at > UTC_TIMESTAMP() AND ce.deleted_at IS NULL AND ce.status <> 'cancelled'`;

export async function countDiscontinuationImpact(
  q: { query: Tx['query'] }, gymId: string, activityTypeId: number | string,
): Promise<{ events: number; booked_events: number }> {
  const { rows } = await q.query(
    `SELECT COUNT(*) AS cnt,
            COALESCE(SUM(EXISTS (SELECT 1 FROM calendar_event_bookings b
              WHERE b.calendar_event_id = ce.id AND b.status = 'booked')), 0) AS booked_cnt
     FROM calendar_events ce WHERE ${FUTURE}`,
    [activityTypeId, gymId],
  );
  return { events: Number(rows[0]?.cnt ?? 0), booked_events: Number(rows[0]?.booked_cnt ?? 0) };
}

export async function discontinueFutureEvents(
  tx: Tx, gymId: string, activityTypeId: number | string, actor: string | null,
): Promise<DiscontinuationResult> {
  const { rows: events } = await tx.query(
    `SELECT ce.id FROM calendar_events ce WHERE ${FUTURE} ORDER BY ce.id FOR UPDATE`,
    [activityTypeId, gymId],
  );
  const ids = events.map((e: any) => Number(e.id));
  if (ids.length === 0) return { deletedEvents: 0, cancelledEvents: 0, memberIds: [] };
  const inList = ids.map(() => '?').join(',');

  const { rows: members } = await tx.query(
    `SELECT DISTINCT member_id FROM calendar_event_bookings
     WHERE gym_id = ? AND calendar_event_id IN (${inList}) AND status IN ('booked', 'waitlisted')`,
    [gymId, ...ids],
  );

  // Events that must survive as cancelled: a booked member, or any booking
  // other than a waiting-list entry (history), or a consumption on a booking.
  const { rows: keep } = await tx.query(
    `SELECT DISTINCT calendar_event_id AS id FROM calendar_event_bookings
     WHERE gym_id = ? AND calendar_event_id IN (${inList}) AND status <> 'waitlisted'
     UNION
     SELECT DISTINCT b.calendar_event_id FROM calendar_event_bookings b
       JOIN professional_service_consumptions c ON c.calendar_event_booking_id = b.id
     WHERE b.gym_id = ? AND b.calendar_event_id IN (${inList})`,
    [gymId, ...ids, gymId, ...ids],
  );
  const keepIds = keep.map((r: any) => Number(r.id));
  const keepSet = new Set(keepIds);
  const dropIds = ids.filter((id) => !keepSet.has(id));

  if (keepIds.length > 0) {
    const keepList = keepIds.map(() => '?').join(',');
    await tx.query(
      `UPDATE calendar_event_bookings
       SET status = 'cancelled', cancelled_at = UTC_TIMESTAMP(),
           modified_at = UTC_TIMESTAMP(), modified_by = ?
       WHERE gym_id = ? AND status = 'waitlisted' AND calendar_event_id IN (${keepList})`,
      [actor, gymId, ...keepIds],
    );
    await tx.query(
      `UPDATE calendar_events
       SET status = 'cancelled', modified_at = UTC_TIMESTAMP(), modified_by = ?
       WHERE gym_id = ? AND id IN (${keepList})`,
      [actor, gymId, ...keepIds],
    );
  }
  if (dropIds.length > 0) {
    const dropList = dropIds.map(() => '?').join(',');
    await tx.query(
      `DELETE FROM calendar_event_bookings WHERE gym_id = ? AND calendar_event_id IN (${dropList})`,
      [gymId, ...dropIds],
    );
    await tx.query(
      `DELETE FROM calendar_events WHERE gym_id = ? AND id IN (${dropList})`,
      [gymId, ...dropIds],
    );
  }
  return {
    deletedEvents: dropIds.length,
    cancelledEvents: keepIds.length,
    memberIds: members.map((m: any) => Number(m.member_id)),
  };
}

/** One alert per member for the Activity — never one per event (#2324 §3). */
export async function alertActivityDiscontinued(
  gymId: string, activityTypeId: number | string, activityName: string, memberIds: number[],
): Promise<number> {
  const unique = [...new Set(memberIds)];
  return recordNotifications(gymId, unique.map((memberId) => ({
    memberId, type: 'activity_discontinued' as const, entityType: null, entityId: null,
    payload: { title: activityName, activity_type_id: Number(activityTypeId), activity_name: activityName },
  })));
}
