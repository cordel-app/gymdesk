import { Tx } from '../infra/db';

/**
 * #2670 stage 1 — every Member belongs to a Family. A Family may hold one Member, so a
 * Member with no other family is the owner of a family of their own (the "solo family").
 *
 * This is the one place a solo family is created: on member creation (both writers of
 * `members`), when a member is removed from a family, and when a family is dissolved.
 * The owner of a solo family is the member, so payer resolution (#2123 stage 2) answers
 * the member themself exactly as it did when they had no family.
 */
export async function createSoloFamily(
  tx: Pick<Tx, 'query'>, gymId: string, memberId: number, name: string, actor: string | null,
): Promise<number> {
  const fam = await tx.query('INSERT INTO families (gym_id, name, created_by) VALUES (?, ?, ?)',
    [gymId, (name || 'Family').slice(0, 255), actor]);
  await tx.query(
    'INSERT INTO family_members (gym_id, family_id, member_id, is_owner, created_by) VALUES (?, ?, ?, 1, ?)',
    [gymId, fam.insertId, memberId, actor]);
  return fam.insertId;
}
