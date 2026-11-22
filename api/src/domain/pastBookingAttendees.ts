/**
 * #3180 — who else attended a member's past booking, as the member may see it.
 *
 * The one place that splits an occurrence's attendees for the Members App's Past
 * bookings: the other members of the caller's own Family by name, everybody else
 * as a count only. An attendee outside the Family is never named, so nothing about
 * them leaves this function but the number.
 *
 * "Attended" is the attendance roll's own answer: a `booked` row marked `present`.
 * A pending roll is not attendance and a cancelled or waitlisted row never was.
 */
export interface AttendeeRow {
  calendar_event_id: number;
  member_id: number;
  name: string;
}

export interface PastBookingAttendees {
  /** The other Family members who attended, by name; `null` when the caller's Family has nobody else. */
  family_attendees: Array<{ member_id: number; name: string }> | null;
  /** Attendees outside the caller's Family: a count, never an identity. */
  other_attendees_count: number;
}

export function splitPastBookingAttendees(
  eventIds: readonly number[],
  rows: readonly AttendeeRow[],
  selfMemberId: number,
  familyMemberIds: readonly number[],
): Map<number, PastBookingAttendees> {
  const family = new Set(familyMemberIds.map(Number));
  family.delete(Number(selfMemberId));
  const hasFamily = family.size > 0;
  const out = new Map<number, PastBookingAttendees>();
  for (const id of eventIds) {
    out.set(Number(id), { family_attendees: hasFamily ? [] : null, other_attendees_count: 0 });
  }
  const seen = new Set<string>();
  for (const r of rows) {
    const eventId = Number(r.calendar_event_id);
    const memberId = Number(r.member_id);
    const entry = out.get(eventId);
    if (!entry || memberId === Number(selfMemberId)) continue;
    const key = `${eventId}:${memberId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (family.has(memberId)) entry.family_attendees!.push({ member_id: memberId, name: r.name });
    else entry.other_attendees_count += 1;
  }
  for (const entry of out.values()) {
    entry.family_attendees?.sort((a, b) => a.name.localeCompare(b.name));
  }
  return out;
}
