// #2657 stage 2 — the Member column of the Assigned Plan card's benefit grid.
//
// A plan line of an Individual Product carries `unit_assignees` (#2609 stage 3): one
// family member per unit, as the server resolved it (`api/src/domain/planUnitAssignees.ts`
// decides the distribution; this module only reads it). The card draws such a line as
// one row per member who holds units of it, and a Shared line (`unit_assignees` null)
// as one row with no member. Pure: no React, no `t()`, no request.

export interface UnitAssigneeMember { member_id: number; name: string }

export interface MemberAllocation {
  /** `null` for a Shared Product (or a response written before #2609): one row, no member. */
  member_id: number | null;
  member_name: string | null;
  /** How many of the line's units this member holds; the whole quantity for a Shared line. */
  quantity: number;
}

/**
 * One allocation per distinct member, in the order the members first hold a unit, with
 * the count of units each holds. A line with no per-unit assignee is one allocation of
 * its whole quantity with no member, so a Shared Product is never repeated per member.
 */
export function memberAllocations(
  line: { quantity: number; unit_assignees?: UnitAssigneeMember[] | null },
): MemberAllocation[] {
  const units = line.unit_assignees ?? [];
  if (units.length === 0) return [{ member_id: null, member_name: null, quantity: Number(line.quantity) }];
  const byMember = new Map<number, MemberAllocation>();
  for (const u of units) {
    const a = byMember.get(u.member_id);
    if (a) a.quantity += 1;
    else byMember.set(u.member_id, { member_id: u.member_id, member_name: u.name || null, quantity: 1 });
  }
  return [...byMember.values()];
}

/**
 * The server's line total spread over the allocations' quantities, in cents, so the
 * rows add up to the line exactly (largest remainder). Display only: the figure is the
 * server's and nothing is re-priced; a `null` total stays `null` on every row.
 */
export function splitLineAmount(total: number | null | undefined, quantities: number[]): (number | null)[] {
  if (total == null) return quantities.map(() => null);
  const sum = quantities.reduce((s, q) => s + q, 0);
  if (quantities.length <= 1 || sum <= 0) return quantities.map(() => total);
  const cents = Math.round(total * 100);
  const exact = quantities.map((q) => (cents * q) / sum);
  const floors = exact.map((x) => Math.floor(x));
  let left = cents - floors.reduce((s, x) => s + x, 0);
  const order = exact.map((x, i) => [x - Math.floor(x), i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (const [, i] of order) { if (left <= 0) break; floors[i] += 1; left -= 1; }
  return floors.map((c) => c / 100);
}
