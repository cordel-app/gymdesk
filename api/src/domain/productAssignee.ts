// #2609 stage 1 — who an Individual Product assignment is for, decided in one place.
//
// A Product bought or assigned individually belongs to one person. When the purchaser
// (or the Product Set owner) belongs to a family, that person may be any member of the
// family; otherwise it is the purchaser themself. A `shared` Product stores no assignee
// (`sharing_type`, #2393): the whole family holds it, and it reads as the purchaser's.
// This module is pure: the SQL half (`api/src/api/product-assignee.ts`) loads the family
// and asks it.

export type AssigneeInput =
  | { kind: 'absent' }
  | { kind: 'none' }
  | { kind: 'member'; memberId: number }
  | { kind: 'invalid' };

/** A request's `assigned_member_id`: absent keeps the default, `null`/`''` is the default too, else a positive integer. */
export function parseAssignedMemberInput(raw: unknown): AssigneeInput {
  if (raw === undefined) return { kind: 'absent' };
  if (raw === null || raw === '') return { kind: 'none' };
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return { kind: 'invalid' };
  return { kind: 'member', memberId: n };
}

export type AssigneeRefusal = 'assignee_invalid' | 'assignee_not_in_family' | 'assignee_not_allowed';

export const ASSIGNEE_MESSAGES: Record<AssigneeRefusal, string> = {
  assignee_invalid: 'assigned_member_id must be a positive integer',
  assignee_not_in_family: 'The assigned member must be the member or a member of their family',
  assignee_not_allowed: 'A shared product is not assigned to one family member',
};

/**
 * The member an assignment is stored for.
 *
 * - `individual`: the requested member when they are the purchaser or in their family,
 *   else the purchaser; an outsider is refused, never silently replaced.
 * - `shared`: `null`, and naming anyone but the purchaser is refused (the purchaser is
 *   accepted as "no choice", so a client that always sends the selector's default works).
 */
export function resolveAssignee(input: {
  requested: AssigneeInput;
  purchaserId: number;
  /** The members of the purchaser's family (the purchaser included or not); empty when none. */
  familyMemberIds: readonly number[];
  sharingType: string | null | undefined;
}): { ok: true; assignedMemberId: number | null } | { ok: false; error: AssigneeRefusal } {
  const { requested, purchaserId } = input;
  if (requested.kind === 'invalid') return { ok: false, error: 'assignee_invalid' };
  if (input.sharingType === 'shared') {
    if (requested.kind === 'member' && requested.memberId !== purchaserId) {
      return { ok: false, error: 'assignee_not_allowed' };
    }
    return { ok: true, assignedMemberId: null };
  }
  if (requested.kind !== 'member') return { ok: true, assignedMemberId: purchaserId };
  if (requested.memberId === purchaserId || input.familyMemberIds.includes(requested.memberId)) {
    return { ok: true, assignedMemberId: requested.memberId };
  }
  return { ok: false, error: 'assignee_not_in_family' };
}

/**
 * The SQL fragment that reads a row's assignee: the stored one, else `fallbackExpr` (the
 * purchaser of a purchase, the owner of a recurring line's Product Set). A row written
 * before the column existed and a shared Product both store NULL and read as that person —
 * the one who holds it — because a purchase read never joins the live `products` row
 * (#1118 §13), so nothing on read can tell the two apart, and both are who held it until now.
 */
export function assignedMemberSql(rowAlias: string, fallbackExpr: string): string {
  return `COALESCE(${rowAlias}.assigned_member_id, ${fallbackExpr})`;
}
