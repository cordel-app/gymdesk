// #2609 stage 1 — the SQL half of `domain/productAssignee.ts`: the family a member
// belongs to, the recipients a selector may offer, and the one resolver every writer
// of an Individual Product assignment calls.

import type { Tx } from '../infra/db';
import { ASSIGNEE_MESSAGES, parseAssignedMemberInput, resolveAssignee, type AssigneeRefusal } from '../domain/productAssignee';

type Queryable = Pick<Tx, 'query'>;

export interface EligibleAssignee {
  member_id: number;
  name: string;
  is_owner: boolean;
}

/** The members of the family `memberId` belongs to (themself included), or `[]` when they have no family. */
export async function loadEligibleAssignees(q: Queryable, gymId: string, memberId: number): Promise<EligibleAssignee[]> {
  const { rows } = await q.query<any>(
    `SELECT fm.member_id, m.name, fm.is_owner
       FROM family_members me
       JOIN family_members fm ON fm.family_id = me.family_id AND fm.gym_id = me.gym_id
       JOIN members m ON m.id = fm.member_id AND m.deleted_at IS NULL
      WHERE me.gym_id = ? AND me.member_id = ?
      ORDER BY fm.is_owner DESC, m.name ASC`,
    [gymId, memberId]);
  return rows.map((r: any) => ({ member_id: Number(r.member_id), name: r.name, is_owner: Number(r.is_owner) === 1 }));
}

/** Thrown by `resolveAssignedMember()`; the route answers `400 { error, message }`. */
export class AssigneeRefused extends Error {
  readonly status = 400;
  constructor(readonly code: AssigneeRefusal) { super(ASSIGNEE_MESSAGES[code]); }
}

/**
 * The member a new assignment of `productId` for `purchaserId` is stored for: the
 * requested one when they are the purchaser or in their family, the purchaser when
 * nothing is requested, `null` for a shared Product. Refuses rather than coerces.
 */
export async function resolveAssignedMember(
  q: Queryable, gymId: string, purchaserId: number, productId: number, raw: unknown,
): Promise<number | null> {
  const requested = parseAssignedMemberInput(raw);
  const { rows } = await q.query<{ sharing_type: string | null }>(
    'SELECT sharing_type FROM products WHERE id = ? AND gym_id = ?', [productId, gymId]);
  const family = requested.kind === 'member' ? await loadEligibleAssignees(q, gymId, purchaserId) : [];
  const resolved = resolveAssignee({
    requested, purchaserId, familyMemberIds: family.map((m) => m.member_id), sharingType: rows[0]?.sharing_type ?? null,
  });
  if (!resolved.ok) throw new AssigneeRefused(resolved.error);
  return resolved.assignedMemberId;
}
