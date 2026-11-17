import type { Tx } from '../infra/db';
import { DRAFT_TTL_MINUTES } from '../domain/productSet';
import { planSnapshotInheritedSql } from './plan-snapshot-lines';

/**
 * #2858 — the one answer to "may staff keep editing this Draft instead of starting another".
 *
 * A Draft Product Set is editable as many times as needed until Save & Pay, so the routes that
 * open a Draft (Members → Products, `⋮ → Edit` on a running plan) reuse the owner's live Draft
 * rather than answering `in_flight`. Two kinds are the same configuration work and are reused:
 *
 *  - a **plain** Draft (no linked assignment): the recurring-products Draft `ensureRecurringDraft()`
 *    has always reused;
 *  - an **edit** Draft: linked to a Draft assignment, every billable plan of which carries over from
 *    the previous version (`planSnapshotInheritedSql()`, the one "inherited" rule) — `⋮ → Edit` on a
 *    running plan, which is a clone of the Active version.
 *
 * A Draft that adds a **new** plan (Assign New Plan, `POST /user-memberships`, the bulk assign) is
 * a genuinely new configuration and is not reused, and a Pending Payment version is never a Draft:
 * both still answer `in_flight`, so one in-flight version per owner stays the rule.
 */
export const editableDraftSql = (ps: string): string =>
  `(${ps}.status = 'in_cart'
    AND ${ps}.last_activity_at >= UTC_TIMESTAMP() - INTERVAL ${DRAFT_TTL_MINUTES} MINUTE
    AND (${ps}.plan_assignment_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM product_set_plan_snapshots ej_ JOIN plan_snapshots es_ ON es_.id = ej_.plan_snapshot_id
       WHERE ej_.product_set_id = ${ps}.id AND ej_.entitlement_only = 0
         AND NOT ${planSnapshotInheritedSql('es_', `${ps}.id`)})))`;

/**
 * #2891 — the Draft a staff member's Product change goes into: **any** live Draft of the owner,
 * a new-plan assignment Draft included. The open Draft is the member's shopping cart until
 * Save & Pay, so adding, editing or removing a recurring Product from Members → Products edits it
 * instead of answering `in_flight`. Wider than `editableDraftSql()` on purpose: that one still
 * decides what `⋮ → Edit` on a running plan may adopt. A Pending Payment version is never a Draft
 * and an expired Draft is not live, so both keep their lifecycle and one in-flight version per
 * owner stays the rule.
 */
export const staffProductDraftSql = (ps: string): string =>
  `(${ps}.status = 'in_cart'
    AND ${ps}.last_activity_at >= UTC_TIMESTAMP() - INTERVAL ${DRAFT_TTL_MINUTES} MINUTE)`;

/** The owner's live Draft staff may keep editing, locked; `null` when there is none. */
export async function lockEditableDraft(
  tx: Pick<Tx, 'query'>, gymId: string, ownerMemberId: number,
): Promise<{ id: number; user_membership_id: number | null; previous_product_set_id: number | null } | null> {
  const { rows } = await tx.query<any>(
    `SELECT ps.id, ps.user_membership_id, ps.previous_product_set_id FROM product_sets ps
      WHERE ps.gym_id = ? AND ps.owner_member_id = ? AND ${editableDraftSql('ps')}
      FOR UPDATE`,
    [gymId, ownerMemberId]);
  const r = rows[0];
  if (!r) return null;
  return {
    id: Number(r.id),
    user_membership_id: r.user_membership_id == null ? null : Number(r.user_membership_id),
    previous_product_set_id: r.previous_product_set_id == null ? null : Number(r.previous_product_set_id),
  };
}
