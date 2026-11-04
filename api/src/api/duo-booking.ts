import type { Tx } from '../infra/db';
import { db } from '../infra/db';
import { MEMBER_MEMBERSHIP_SQL } from '../domain/assignmentRelationship';
import { cancelBooking } from './bookings';
import { recordNotifications } from '../infra/notifications';

/**
 * Whether two members are linked through plan coverage: some live assignment
 * is owned by or covers both (#1984 stage 2b-1: "only members linked through
 * plan coverage"). Read through `MEMBER_MEMBERSHIP_SQL`, never the owner
 * column alone.
 */
export async function membersShareCoverage(tx: Tx, gymId: string, a: number, b: number): Promise<boolean> {
  const { rows } = await tx.query(
    `SELECT 1 FROM user_memberships um
      WHERE um.gym_id = ? AND um.status = 'active'
        AND ${MEMBER_MEMBERSHIP_SQL}
        AND ${MEMBER_MEMBERSHIP_SQL}
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
