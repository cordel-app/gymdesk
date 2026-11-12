import { db, Tx } from '../infra/db';

/**
 * #2670 stage 2: the one place that answers "whose Professional Services wallet is this
 * member's?". The wallet belongs to the member's Family (#2670 stage 1 gave every member
 * one): the grants of every member of the family, less the family's consumption ledger,
 * reservations and staff corrections. A member with no family row (only possible for a
 * row written outside the two `members` writers) is a wallet of one.
 *
 * Soft-deleted members are left out of `memberIds`: their grants stop funding the family
 * the way they stopped funding themselves, and a restore brings them back.
 */
export interface FamilyWallet {
  familyId: number | null;
  /** The members whose grants the wallet holds; always includes the member asked about. */
  memberIds: number[];
}

type Q = Pick<Tx, 'query'>;

export async function familyWalletOf(q: Q | typeof db, gymId: string, memberId: number): Promise<FamilyWallet> {
  const { rows } = await q.query<{ family_id: number; member_id: number }>(
    `SELECT fm.family_id, fm2.member_id
       FROM family_members fm
       JOIN family_members fm2 ON fm2.family_id = fm.family_id AND fm2.gym_id = fm.gym_id
       JOIN members m ON m.id = fm2.member_id AND m.deleted_at IS NULL
      WHERE fm.member_id = ? AND fm.gym_id = ?
      ORDER BY fm2.member_id`,
    [memberId, gymId],
  );
  if (rows.length === 0) {
    const { rows: own } = await q.query<{ family_id: number }>(
      'SELECT family_id FROM family_members WHERE member_id = ? AND gym_id = ?', [memberId, gymId]);
    return { familyId: own[0] ? Number(own[0].family_id) : null, memberIds: [memberId] };
  }
  const ids = new Set(rows.map((r) => Number(r.member_id)));
  ids.add(memberId);
  return { familyId: Number(rows[0].family_id), memberIds: [...ids].sort((a, b) => a - b) };
}

/** `(?, ?, …)` for an IN list of the wallet's members. */
export function inList(ids: readonly number[]): string {
  return `(${ids.map(() => '?').join(', ')})`;
}

/**
 * Serialise every write that reads the wallet and then writes against it (a reservation,
 * a staff correction): the family row when there is one, else the member row.
 */
export async function lockWallet(tx: Q, gymId: string, wallet: FamilyWallet, memberId: number): Promise<void> {
  if (wallet.familyId != null) {
    await tx.query('SELECT id FROM families WHERE id = ? AND gym_id = ? FOR UPDATE', [wallet.familyId, gymId]);
  } else {
    await tx.query('SELECT id FROM members WHERE id = ? AND gym_id = ? FOR UPDATE', [memberId, gymId]);
  }
}

/** The family a ledger row written for `memberId` belongs to — the subselect every INSERT uses. */
export const MEMBER_FAMILY_SQL = '(SELECT fmw.family_id FROM family_members fmw WHERE fmw.member_id = ? AND fmw.gym_id = ?)';

/**
 * A family is about to be deleted (its only member joined another family, or it was
 * dissolved). Its ledger rows go to the family each row's member belongs to now, so a
 * solo member joining a family brings their history and corrections, and a dissolved
 * family's rows return to the members they were recorded on. Call it after the members'
 * new `family_members` rows exist and before the old family is deleted.
 */
export async function repointFamilyLedger(tx: Q, gymId: string, oldFamilyId: number): Promise<void> {
  for (const table of ['professional_service_consumptions', 'professional_service_reservations', 'professional_service_adjustments']) {
    await tx.query(
      `UPDATE ${table} t
         JOIN family_members fm ON fm.member_id = t.member_id AND fm.gym_id = t.gym_id
          SET t.family_id = fm.family_id
        WHERE t.gym_id = ? AND t.family_id = ? AND fm.family_id <> ?`,
      [gymId, oldFamilyId, oldFamilyId],
    );
  }
}
