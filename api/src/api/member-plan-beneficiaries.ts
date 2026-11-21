import type { Tx } from '../infra/db';
import { db } from '../infra/db';
import { beneficiarySelectionError, parseBeneficiaryIds } from '../domain/planBeneficiaries';
import { ownerFamilyMemberIds } from './owner-family';
import { addCoverage } from './product-sets';
import { primaryPlanSnapshotId, setOwnerIsBeneficiary } from './plan-snapshot-lines';

/**
 * #3091: the beneficiaries a member picks while contracting a Membership Plan in the Members App.
 * Judged by the rule staff's assignment uses (`beneficiarySelectionError()`), against the contracting
 * member's own family; the member is never forced into the selection. `undefined` = the request did not
 * name any (the pre-#3091 behaviour: the contracting member alone), so an older client keeps working.
 */
export async function judgeMemberBeneficiaries(
  gymId: string, ownerId: number, planId: number, raw: unknown,
): Promise<{ ids: number[] | undefined } | { status: number; body: Record<string, unknown> }> {
  const parsed = parseBeneficiaryIds(raw);
  if (parsed === undefined) return { ids: undefined };
  if (parsed === null) return { status: 400, body: { error: 'beneficiary_member_ids must be an array of positive integers' } };
  const { rows } = await db.query<{ member_limit: string | null }>(
    'SELECT member_limit FROM membership_plans WHERE id = ? AND gym_id = ?', [planId, gymId]);
  const familyMemberIds = await ownerFamilyMemberIds(db, gymId, ownerId);
  const refusal = beneficiarySelectionError({ limit: rows[0]?.member_limit, familyMemberIds, beneficiaryIds: parsed });
  if (refusal) return { status: 400, body: { ...refusal } };
  return { ids: parsed };
}

/** Writes the judged selection onto the plan snapshot the caller has just created (same transaction). */
export async function applyMemberBeneficiaries(
  tx: Tx, gymId: string, productSetId: number, ownerId: number, ids: readonly number[] | undefined,
): Promise<void> {
  if (ids === undefined) return;
  const snapshotId = await primaryPlanSnapshotId(tx, gymId, productSetId);
  if (snapshotId == null) return;
  if (!ids.includes(ownerId)) await setOwnerIsBeneficiary(tx, gymId, snapshotId, false);
  for (const memberId of ids) {
    if (memberId === ownerId) continue;
    await addCoverage(tx, { gymId, productSetId, memberId, isOwner: false, planSnapshotId: snapshotId });
  }
}
