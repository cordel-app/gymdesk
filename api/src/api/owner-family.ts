import type { Tx } from '../infra/db';

type Exec = { query: Tx['query'] };

/**
 * #2879: the members of `memberId`'s family (the member included), live members only. A
 * member with no family row (legacy data) is a family of one. The one read both the plan
 * assignment (`POST /membership-plans/:id/assign`) and a Draft's beneficiary edit
 * (`PUT /user-memberships/:id/beneficiaries`) judge a selection against.
 */
export async function ownerFamilyMemberIds(exec: Exec, gymId: string, memberId: number): Promise<number[]> {
  const { rows } = await exec.query<{ member_id: number }>(
    `SELECT fm.member_id FROM family_members fm
       JOIN family_members me ON me.family_id = fm.family_id AND me.gym_id = fm.gym_id
       JOIN members m ON m.id = fm.member_id AND m.deleted_at IS NULL
      WHERE me.member_id = ? AND me.gym_id = ?`,
    [memberId, gymId],
  );
  const ids = rows.map((r) => Number(r.member_id));
  return ids.includes(memberId) ? ids : [memberId, ...ids];
}
