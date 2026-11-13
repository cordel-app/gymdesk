import type { Tx } from '../infra/db';
import { db } from '../infra/db';
import { assignmentCoversMemberSql, isCurrentAssignmentSnapshotSql } from '../domain/planAssignments';
import { cancelBooking } from './bookings';
import { recordNotifications } from '../infra/notifications';

/**
 * Whether two members are linked through plan coverage: some live assignment
 * is owned by or covers both (#1984 stage 2b-1: "only members linked through
 * plan coverage"). Never the owner column alone. #2125 M6b-5: the assignment
 * is its current plan snapshot and coverage is that snapshot's beneficiaries.
 */
export async function membersShareCoverage(tx: Tx, gymId: string, a: number, b: number): Promise<boolean> {
  const { rows } = await tx.query(
    `SELECT 1 FROM plan_snapshots pa
      WHERE pa.gym_id = ? AND pa.status = 'active' AND ${isCurrentAssignmentSnapshotSql('pa')}
        AND (pa.member_id = ? OR ${assignmentCoversMemberSql('pa')})
        AND (pa.member_id = ? OR ${assignmentCoversMemberSql('pa')})
      LIMIT 1`,
    [gymId, a, a, b, b],
  );
  return rows.length > 0;
}

/**
 * Cancels the other live rows of a booking's group (the caller already
 * cancelled `bookingId`) and tells each partner why. Returns the cancelled
 * partner member ids and anyone promoted off the waiting list.
 */
export async function cancelGroupPartners(
  gymId: string, groupId: string, bookingId: number, actor: string | null,
  alert: { sessionId: number; title: string; starts_at: string },
): Promise<{ promotedMemberIds: number[] }> {
  const { rows } = await db.query(
    `SELECT id, member_id FROM calendar_event_bookings
      WHERE gym_id = ? AND booking_group_id = ? AND id <> ? AND status IN ('booked','waitlisted')`,
    [gymId, groupId, bookingId],
  );
  const promotedMemberIds: number[] = [];
  const notified: number[] = [];
  for (const r of rows) {
    const res = await cancelBooking(gymId, Number(r.id), null, { spendLateCancel: false, actor });
    notified.push(Number(r.member_id));
    if (res.promotedMemberId) promotedMemberIds.push(Number(res.promotedMemberId));
  }
  await recordNotifications(gymId, notified.map((memberId) => ({
    memberId, type: 'booking_cancelled_by_partner' as const, entityType: 'session' as const,
    entityId: alert.sessionId, payload: { title: alert.title, starts_at: alert.starts_at },
  })));
  return { promotedMemberIds };
}
