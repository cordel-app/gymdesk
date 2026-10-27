import { db, Tx } from '../infra/db';
import { resolvePayer, ResolvedPayer } from '../domain/payerResolution';

type Q = Pick<Tx, 'query'> | typeof db;

/**
 * SQL scalar: the payer of the Member in `memberExpr`/`gymExpr` — the Family Owner of their
 * family, else the Member. The SQL spelling of `resolvePayer()`, for queries that resolve a
 * page of rows at once (the nightly run, the card-removal guard).
 */
export function payerMemberSql(memberExpr: string, gymExpr: string): string {
  return `COALESCE((SELECT fo.member_id FROM family_members fm
                      JOIN family_members fo ON fo.family_id = fm.family_id AND fo.is_owner = 1
                     WHERE fm.member_id = ${memberExpr} AND fm.gym_id = ${gymExpr}), ${memberExpr})`;
}

export async function loadFamilyOwnerId(q: Q, gymId: string, memberId: number): Promise<number | null> {
  const { rows } = await q.query<{ owner_id: number }>(
    `SELECT fo.member_id AS owner_id
       FROM family_members fm
       JOIN family_members fo ON fo.family_id = fm.family_id AND fo.is_owner = 1
      WHERE fm.member_id = ? AND fm.gym_id = ?`,
    [memberId, gymId]);
  return rows[0] ? Number(rows[0].owner_id) : null;
}

export async function resolvePayerFor(q: Q, gymId: string, beneficiaryMemberId: number): Promise<ResolvedPayer> {
  return resolvePayer(beneficiaryMemberId, await loadFamilyOwnerId(q, gymId, beneficiaryMemberId));
}
