/**
 * #1984 stage 2b — the SQL half of `domain/bookingParticipants.ts`: the linked
 * members a booker may bring to an occurrence.
 *
 * "Linked" is the Membership's own coverage, never the Family (#2123 derives no
 * payer or entitlement from a family): two members are linked when an active
 * Membership covers both, owner included — owner-to-linked, linked-to-owner and
 * linked-to-linked alike (`MEMBER_MEMBERSHIP_SQL`, #1191). A candidate must also
 * be eligible for the chosen service by the one eligibility decision, and not be
 * on the occurrence already.
 */
import type { Tx } from '../infra/db';
import { MEMBER_MEMBERSHIP_SQL } from '../domain/assignmentRelationship';
import { resolveActivityTypeEligibility } from './activity-eligibility';

interface Queryable { query: Tx['query'] }

export interface LinkedParticipant {
  id: number;
  name: string;
  /** The services of the occurrence this member could use. */
  professional_service_ids: number[];
}

export async function loadLinkedParticipants(
  q: Queryable, gymId: string, bookerId: number, eventId: number, serviceId?: number | null,
): Promise<LinkedParticipant[]> {
  const { rows: ev } = await q.query(
    `SELECT activity_type_id FROM calendar_events
      WHERE id = ? AND gym_id = ? AND deleted_at IS NULL AND status = 'scheduled'`,
    [eventId, gymId],
  );
  if (ev.length === 0) return [];
  const activityTypeId = Number(ev[0].activity_type_id);

  const { rows: linked } = await q.query(
    `SELECT DISTINCT m.id, m.name
       FROM user_memberships um
       JOIN members m ON m.gym_id = um.gym_id AND m.deleted_at IS NULL AND m.id <> ?
        AND (m.id = um.member_id OR EXISTS (
              SELECT 1 FROM user_membership_members x
               WHERE x.user_membership_id = um.id AND x.gym_id = um.gym_id AND x.member_id = m.id))
      WHERE um.gym_id = ? AND um.status = 'active' AND ${MEMBER_MEMBERSHIP_SQL}
        AND NOT EXISTS (
              SELECT 1 FROM calendar_event_bookings b
               WHERE b.gym_id = um.gym_id AND b.calendar_event_id = ? AND b.member_id = m.id
                 AND b.status IN ('booked', 'waitlisted'))
      ORDER BY m.name ASC`,
    [bookerId, gymId, bookerId, bookerId, eventId],
  );

  const out: LinkedParticipant[] = [];
  for (const m of linked as Array<{ id: number; name: string }>) {
    const decision = await resolveActivityTypeEligibility(q as Tx, gymId, Number(m.id), activityTypeId, { calendarEventId: eventId });
    if (!decision.eligible) continue;
    const ids = decision.matched.map((x) => Number(x.professional_service_id));
    if (serviceId != null && !ids.includes(serviceId)) continue;
    out.push({ id: Number(m.id), name: m.name, professional_service_ids: ids });
  }
  return out;
}
