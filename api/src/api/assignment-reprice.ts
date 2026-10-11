import { Tx } from '../infra/db';
import { linkedDraftSetFor } from './assignment-draft-set';
import { syncDraftAssignment } from './product-set-projection';
import { reconfigureProjected } from './product-set-bridge';

/**
 * #1325 PR 3e-2 — the Plan's *Apply new price to assigned plans* writes the new
 * regular fee onto the **version** an assignment's configuration is, not onto the
 * assignment row (which is a cache the readers no longer take its fee from):
 *
 *  - a **Draft** version is updated in place and the row re-derived;
 *  - an **Active** version is repriced as a new version (`reconfigureProjected()`:
 *    its future Scheduled events are replaced at the new price, which is what
 *    makes the new fee what is *charged* and not only what is displayed);
 *  - a **Pending Payment** or closed version is left as it was — it is locked by
 *    Save & Pay or is the record of what was billed;
 *  - an assignment with **no version** does not exist since migration 258.
 */

export type RepriceOutcome = 'updated' | 'skipped';

async function latestLinkedStatus(tx: Tx, gymId: string, userMembershipId: number): Promise<string | null> {
  const { rows } = await tx.query<{ status: string }>(
    `SELECT status FROM product_sets WHERE gym_id = ? AND user_membership_id = ?
      ORDER BY version DESC, id DESC LIMIT 1`,
    [gymId, userMembershipId],
  );
  return rows[0]?.status ?? null;
}

async function writePrice(tx: Tx, gymId: string, setId: number, price: number, planPriceId: number | null) {
  await tx.query(
    `UPDATE product_set_plan_snapshots
        SET membership_fee_price = ?, base_price = ?, plan_price_id = ?
      WHERE product_set_id = ? AND gym_id = ?`,
    [price, price, planPriceId, setId, gymId],
  );
}

export async function repriceOnVersion(tx: Tx, input: {
  gymId: string; userMembershipId: number; price: number; planPriceId: number | null;
  actor: { name: string | null; type: string | null };
}): Promise<RepriceOutcome> {
  const { gymId, userMembershipId, price, planPriceId } = input;
  const status = await latestLinkedStatus(tx, gymId, userMembershipId);
  if (status == null) return 'skipped';

  if (status === 'draft') {
    const draft = await linkedDraftSetFor(tx, gymId, userMembershipId);
    if (!draft) return 'skipped';
    await writePrice(tx, gymId, draft.id, price, planPriceId);
    await syncDraftAssignment(tx, gymId, draft.id);
    return 'updated';
  }
  if (status === 'active') {
    const out = await reconfigureProjected(tx, {
      gymId, userMembershipId, actor: input.actor,
      mutate: async (t, d) => { await writePrice(t, gymId, d.id, price, planPriceId); return { ok: true as const }; },
    });
    if (out.kind === 'ok') return 'updated';
    // A refusal (an unresolved payment locks the edit, a version already in
    // flight, …) leaves the row as it was; the caller rolls its transaction back.
    throw Object.assign(new Error('refused'), { skipped: true });
  }
  return 'skipped';
}

/**
 * A negotiated fee keeps its agreed price; only the reference to the Plan's
 * price window is refreshed. Reference metadata — it prices nothing — so it is
 * written on whichever version the assignment's configuration is.
 */
export async function refreshPlanPriceReference(tx: Tx, input: {
  gymId: string; userMembershipId: number; price: number; planPriceId: number | null;
}): Promise<void> {
  await tx.query(
    `UPDATE product_set_plan_snapshots snap
       JOIN product_sets ps ON ps.id = snap.product_set_id
        SET snap.base_price = ?, snap.plan_price_id = ?
      WHERE ps.gym_id = ? AND ps.user_membership_id = ?
        AND ps.version = (SELECT MAX(p2.version) FROM product_sets p2
                           WHERE p2.gym_id = ps.gym_id AND p2.user_membership_id = ps.user_membership_id)`,
    [input.price, input.planPriceId, input.gymId, input.userMembershipId],
  );
}
