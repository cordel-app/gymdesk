// #2609 stage 3 — which family member receives each unit of an Individual Product a
// Membership Plan includes, decided in one place. Pure: the SQL half is
// `api/src/api/plan-unit-assignees.ts`.
//
// A plan line of quantity N is N units. Each unit of an `individual` Product belongs to one
// person: by default the plan's beneficiaries in order, one unit each, wrapping when there are
// more units than beneficiaries (the owner when the plan has none). Staff may change any unit
// to the owner or a member of the owner's family before the plan is confirmed; a `shared`
// Product has no per-unit assignee at all (#2393). What is stored (`unit_assignees`) is only
// ever an override: a stored entry that is no longer eligible, or a position beyond what was
// stored (the quantity grew), reads as the default for that position.

/** The default distribution: unit i goes to `recipients[i % n]`; with no recipient, to the owner. */
export function defaultUnitAssignees(quantity: number, recipientIds: readonly number[], ownerId: number): number[] {
  const n = Math.max(0, Math.trunc(quantity));
  const pool = recipientIds.length > 0 ? recipientIds : [ownerId];
  return Array.from({ length: n }, (_, i) => pool[i % pool.length]);
}

/** A stored `unit_assignees` value as a list of ids (a JSON string, an array, or nothing). */
export function readStoredUnitAssignees(raw: unknown): (number | null)[] | null {
  let value = raw;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return null; }
  }
  if (!Array.isArray(value)) return null;
  return value.map((v) => {
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : null;
  });
}

/**
 * The member each unit of a line is for, or `null` for a `shared` Product (no per-unit
 * assignee). Always exactly `quantity` entries, every one an eligible member.
 */
export function effectiveUnitAssignees(input: {
  stored: unknown;
  quantity: number;
  sharingType: string | null | undefined;
  ownerId: number;
  /** The plan's beneficiaries, in their order. */
  beneficiaryIds: readonly number[];
  /** Everyone a unit may be given to: the owner, their family and the beneficiaries. */
  eligibleIds: readonly number[];
}): number[] | null {
  if (input.sharingType === 'shared') return null;
  const defaults = defaultUnitAssignees(input.quantity, input.beneficiaryIds, input.ownerId);
  const stored = readStoredUnitAssignees(input.stored) ?? [];
  const eligible = new Set(input.eligibleIds);
  return defaults.map((fallback, i) => {
    const s = stored[i];
    return s != null && eligible.has(s) ? s : fallback;
  });
}

export type UnitAssigneesRefusal =
  | 'assignees_invalid' | 'assignees_wrong_length' | 'assignee_not_in_family' | 'assignee_not_allowed';

export const UNIT_ASSIGNEES_MESSAGES: Record<UnitAssigneesRefusal, string> = {
  assignees_invalid: 'assignees must be an array of member ids',
  assignees_wrong_length: 'assignees must name one member per unit of the line',
  assignee_not_in_family: 'Each unit must be assigned to the plan owner or a member of their family',
  assignee_not_allowed: 'A shared product is not assigned to one family member',
};

/**
 * Judges a request's per-unit distribution for one line: one positive member id per unit,
 * each eligible; a shared Product takes none. Refuses rather than coerces.
 */
export function parseUnitAssigneesInput(input: {
  raw: unknown;
  quantity: number;
  sharingType: string | null | undefined;
  eligibleIds: readonly number[];
}): { ok: true; assignees: number[] } | { ok: false; error: UnitAssigneesRefusal } {
  if (input.sharingType === 'shared') return { ok: false, error: 'assignee_not_allowed' };
  if (!Array.isArray(input.raw)) return { ok: false, error: 'assignees_invalid' };
  const ids: number[] = [];
  for (const v of input.raw) {
    const n = Number(v);
    if (v === null || v === '' || typeof v === 'boolean' || !Number.isInteger(n) || n <= 0) {
      return { ok: false, error: 'assignees_invalid' };
    }
    ids.push(n);
  }
  if (ids.length !== Math.trunc(input.quantity)) return { ok: false, error: 'assignees_wrong_length' };
  const eligible = new Set(input.eligibleIds);
  if (ids.some((id) => !eligible.has(id))) return { ok: false, error: 'assignee_not_in_family' };
  return { ok: true, assignees: ids };
}
