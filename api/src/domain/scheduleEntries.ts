/**
 * #3090 stage 5 — the Professional Services Schedule as a list of entries.
 *
 * An entry is one weekly slot identity (`SlotIdentity`: weekday, times, Activity,
 * Professional Service, center) and the family members whose stored weekly
 * pattern (`member_recurring_slots`, one row per member) holds it. There is no
 * entry table: the rows the grid and the nightly rolling window already read are
 * the schedule, so creating, editing and deleting an entry is adding, moving and
 * removing those rows, and booking still goes through `bookSelectedSlots()` →
 * `bookMemberOnSession()` (the owner's direction of 21 Nov: no second engine).
 *
 * Pure: grouping the rows into entries, judging the request body and the
 * `family_only` minimum. The I/O half is `api/member-schedule-entries.ts`.
 */
import { SlotIdentity, parseSlotIdentities, slotIdentityKey } from './personalTrainingSlots';

/** One `member_recurring_slots` row of the family, with the names the list shows. */
export interface ScheduleEntryRow extends SlotIdentity {
  selection_id: number;
  member_id: number;
  member_name: string;
  professional_service_name: string;
  activity_type_name: string;
  center_name: string | null;
}

export interface ScheduleEntry extends SlotIdentity {
  professional_service_name: string;
  activity_type_name: string;
  center_name: string | null;
  members: { member_id: number; name: string; selection_id: number }[];
}

/**
 * One entry per slot identity, its members alphabetical; entries ordered by
 * Professional Service, then weekday (ISO, Monday first), then start time.
 */
export function groupScheduleEntries(rows: ScheduleEntryRow[]): ScheduleEntry[] {
  const byKey = new Map<string, ScheduleEntry>();
  for (const r of rows) {
    const key = slotIdentityKey(r);
    let entry = byKey.get(key);
    if (!entry) {
      entry = {
        weekday: r.weekday,
        start_time: r.start_time,
        end_time: r.end_time,
        activity_type_id: r.activity_type_id,
        professional_service_id: r.professional_service_id,
        center_id: r.center_id,
        professional_service_name: r.professional_service_name,
        activity_type_name: r.activity_type_name,
        center_name: r.center_name,
        members: [],
      };
      byKey.set(key, entry);
    }
    if (!entry.members.some((m) => m.member_id === r.member_id)) {
      entry.members.push({ member_id: r.member_id, name: r.member_name, selection_id: r.selection_id });
    }
  }
  const entries = Array.from(byKey.values());
  for (const e of entries) {
    e.members.sort((a, b) => a.name.localeCompare(b.name) || a.member_id - b.member_id);
  }
  return entries.sort((a, b) =>
    a.professional_service_name.localeCompare(b.professional_service_name)
    || a.professional_service_id - b.professional_service_id
    || a.weekday - b.weekday
    || a.start_time.localeCompare(b.start_time)
    || a.end_time.localeCompare(b.end_time)
    || slotIdentityKey(a).localeCompare(slotIdentityKey(b)));
}

/** One slot identity from a request field, through the grid's own parser. */
export function parseOneSlot(raw: unknown, field: string): { slot: SlotIdentity } | { error: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { error: `${field} must be an object` };
  }
  const parsed = parseSlotIdentities([raw]);
  if ('error' in parsed) return { error: parsed.error.replace('slots[0]', field) };
  return { slot: parsed.slots[0] };
}

/**
 * The members an entry is for. Absent means the card's own member; otherwise a
 * non-empty list of positive integers (at most 20, the book-family limit), each
 * once. Family membership is the route's question.
 */
export function parseEntryMemberIds(raw: unknown, cardMemberId: number): { ids: number[] } | { error: string } {
  if (raw === undefined) return { ids: [cardMemberId] };
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 20
      || !raw.every((v) => Number.isInteger(v) && (v as number) > 0)) {
    return { error: 'member_ids must be a non-empty list of member ids' };
  }
  return { ids: Array.from(new Set(raw as number[])) };
}

/**
 * §3: a `family_only` service needs at least `min_participants` members on the
 * entry. Any other service takes any number (each member is booked alone).
 */
export function belowFamilyMinimum(
  service: { booking_type: string | null | undefined; min_participants: number | null | undefined } | null,
  memberCount: number,
): number | null {
  if (!service || service.booking_type !== 'family_only') return null;
  const min = Math.max(1, Number(service.min_participants ?? 1));
  return memberCount < min ? min : null;
}
