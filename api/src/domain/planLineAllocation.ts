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

/**
 * #2657 stage 4 — splitting a line already committed before stage 3: a number of units recorded
 * against the unsplit line (one allowance renewal) is shared out over its member lines in
 * proportion to each line's quantity, by largest remainder with ties to the earlier line, so the
 * shares always sum to `total` and a renewal equal to the line's quantity gives each member
 * exactly their own quantity.
 */
export function shareUnits(total: number, weights: readonly number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (weights.length === 0) return [];
  if (sum <= 0 || total <= 0) return weights.map((_, i) => (i === 0 ? Math.max(0, total) : 0));
  const exact = weights.map((w) => (total * w) / sum);
  const out = exact.map((x) => Math.floor(x));
  let left = total - out.reduce((a, b) => a + b, 0);
  const order = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    out[i] += 1;
    left -= 1;
  }
  return out;
}

/**
 * #2657 stage 4 — how many of one holder's sessions already spent from an unsplit line stay on each
 * of its member lines once it is split: each line in order takes what it grants, and whatever is
 * left over (a spend beyond the line's total, which the wallet already read as a debt) stays on the
 * first line, the one that keeps the original id. The counts sum to `spent`.
 */
export function distributeSpends(spent: number, capacities: readonly number[]): number[] {
  if (capacities.length === 0) return [];
  const out = capacities.map(() => 0);
  let left = Math.max(0, spent);
  capacities.forEach((cap, i) => {
    const take = Math.min(left, Math.max(0, cap));
    out[i] = take;
    left -= take;
  });
  out[0] += left;
  return out;
}
