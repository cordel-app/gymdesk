// #3090 stage 5 — pure rules for the Professional Services Schedule entries list.
// The API (`/members/:memberId/personal-training-slots/entries`) judges everything
// (family membership, the family_only minimum, whether a slot is offered); this
// only lists the slots an entry may take, keys them and builds the request bodies.

export interface EntrySlotIdentity {
  weekday: number;
  start_time: string;
  end_time: string;
  activity_type_id: number;
  professional_service_id: number;
  center_id: number | null;
}

export interface OfferedSlot extends EntrySlotIdentity {
  professional_service_name: string;
  activity_type_name: string;
  center_name: string | null;
}

export interface ScheduleEntry extends OfferedSlot {
  members: { member_id: number; name: string; selection_id: number }[];
}

/** The identity the API keys a slot on, as a string. */
export function entrySlotKey(s: EntrySlotIdentity): string {
  return [s.weekday, s.start_time, s.end_time, s.activity_type_id, s.professional_service_id, s.center_id ?? ''].join('|');
}

/** Only the identity fields, so a body never carries the grid's extra columns. */
export function entryIdentity(s: EntrySlotIdentity): EntrySlotIdentity {
  return {
    weekday: s.weekday, start_time: s.start_time, end_time: s.end_time,
    activity_type_id: s.activity_type_id, professional_service_id: s.professional_service_id,
    center_id: s.center_id ?? null,
  };
}

/**
 * The slots an entry may be set to: every slot the grid offers the card's member,
 * weekday then time. An entry's current slot is kept in the list even when the
 * grid no longer offers it, so the edit form still reads it.
 */
export function entrySlotOptions(days: { slots: OfferedSlot[] }[], current?: OfferedSlot | null): OfferedSlot[] {
  const seen = new Set<string>();
  const out: OfferedSlot[] = [];
  for (const d of days) for (const s of d.slots) {
    const key = entrySlotKey(s);
    if (!seen.has(key)) { seen.add(key); out.push(s); }
  }
  if (current && !seen.has(entrySlotKey(current))) out.push(current);
  return out.sort((a, b) => a.weekday - b.weekday || a.start_time.localeCompare(b.start_time)
    || a.professional_service_name.localeCompare(b.professional_service_name));
}

/**
 * #3090 stage 6: whether `+ Add schedule entry` can do anything — an entry is one
 * of the slots the grid offers, so with none it is disabled and explained.
 */
export function canAddScheduleEntry(days: { slots: OfferedSlot[] }[]): boolean {
  return entrySlotOptions(days).length > 0;
}

/** The members a new entry starts with: the card's member. */
export function initialEntryMembers(memberId: number): number[] {
  return [memberId];
}

/** Toggling one member of the draft; the list keeps its order and each id once. */
export function toggleEntryMember(selected: number[], memberId: number): number[] {
  return selected.includes(memberId) ? selected.filter((id) => id !== memberId) : [...selected, memberId];
}

export function createEntryBody(slot: EntrySlotIdentity, memberIds: number[]) {
  return { slot: entryIdentity(slot), member_ids: memberIds };
}

export function updateEntryBody(previous: EntrySlotIdentity, slot: EntrySlotIdentity, memberIds: number[]) {
  return { previous_slot: entryIdentity(previous), slot: entryIdentity(slot), member_ids: memberIds };
}

export function deleteEntryBody(slot: EntrySlotIdentity) {
  return { slot: entryIdentity(slot) };
}

/** The locale key (under `members`) for a refusal the API words with a code. */
export function entryErrorKey(code: string | undefined): string | null {
  switch (code) {
    case 'participants_below_minimum': return 'pt_entries_error_minimum';
    case 'slot_not_available': return 'pt_entries_error_slot';
    case 'member_not_in_family': return 'pt_entries_error_family';
    default: return null;
  }
}
