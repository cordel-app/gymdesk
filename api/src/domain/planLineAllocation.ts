// #2657 stage 3 (option A) — an Individual Product line of a Membership Plan is one
// line per member, decided in one place. Pure: the SQL half is
// `api/src/api/plan-line-allocation.ts`.
//
// A plan snapshot line (`plan_*_snapshots`) of a Shared (Family) Product is one line for
// the whole plan (`assigned_member_id` NULL). An Individual Product is held per member:
// each member's units are a line of their own (`assigned_member_id` set), with its own
// quantity and Direct Discount, so a per-member discount or removal is an ordinary line
// edit and billing prices each line the way it already prices a line. A line still
// carrying no member (written before the split) is read through the default unit
// distribution (#2609 stage 3) until a Draft write splits it.

/** One member's share of a split line. */
export interface MemberAllocation { memberId: number; quantity: number }

/**
 * Groups a line's per-unit assignees (`effectiveUnitAssignees()`, one id per unit) into
 * one allocation per member, in the order each member first appears, so the first group
 * is the one that keeps the original line's id.
 */
export function groupUnitAssignees(assignees: readonly number[]): MemberAllocation[] {
  const out: MemberAllocation[] = [];
  const index = new Map<number, number>();
  for (const id of assignees) {
    const at = index.get(id);
    if (at == null) {
      index.set(id, out.length);
      out.push({ memberId: id, quantity: 1 });
    } else {
      out[at].quantity += 1;
    }
  }
  return out;
}

/**
 * #1187 on split lines: a catalogue-mandatory Individual Product is one unit per member
 * the plan covers. Given the members whose lines exist and the members the plan covers
 * (never empty: the owner when nobody is covered), answers which lines to delete and
 * which members still need one.
 */
export function reconcileMandatoryMembers(
  existing: readonly number[], target: readonly number[],
): { remove: number[]; add: number[] } {
  const want = new Set(target);
  const have = new Set(existing);
  return {
    remove: existing.filter((id) => !want.has(id)),
    add: target.filter((id) => !have.has(id)),
  };
}

/** A line's identity inside one plan snapshot: its Product and the member it is for. */
export const planLineKey = (productId: number, memberId: number | null | undefined): string =>
  `${productId}:${memberId ?? ''}`;

export type PlanLineMemberInput =
  | { keep: true }
  | { keep: false; memberId: number | null }
  | { keep: false; error: string };

/**
 * A section item's `assigned_member_id`: absent names no member (the Product's only line,
 * or a new line the split will distribute), `null` the plan's unsplit line, a positive
 * integer that member's line. Anything else is a 400, never a coercion.
 */
export function parsePlanLineMemberInput(item: unknown): PlanLineMemberInput {
  if (item == null || typeof item !== 'object' || !('assigned_member_id' in item)) return { keep: true };
  const raw = (item as any).assigned_member_id;
  if (raw === null || raw === '') return { keep: false, memberId: null };
  const n = Number(raw);
  if (typeof raw === 'boolean' || !Number.isInteger(n) || n <= 0) {
    return { keep: false, error: 'assigned_member_id must be a member id or null' };
  }
  return { keep: false, memberId: n };
}
