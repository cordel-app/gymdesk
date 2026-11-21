// #2779 — the I/O half of an expanded Past Plan (`domain/pastPlanDetails.ts` decides
// the shape). It reads snapshot tables only and never a catalogue one: the plan
// snapshot that names the assignment, its three line tables, and the assignment's
// own Promotion applications with their grant snapshots.
//
// The whole history is read in a fixed number of queries (snapshot ids, plan
// snapshots, lines, applications, grants), never one round trip per past plan.

import { db } from '../infra/db';
import type { MemberPastPlan } from '../domain/memberPlanHistory';
import {
  EMPTY_PAST_PLAN_DETAILS,
  pastPlanPromotionSnapshot,
  shapePastPlanLines,
  shapePastPlanPromotion,
  type PastPlanDetails,
  type PastPlanLineRow,
  type PastPlanPromotionGrant,
  type PastPlanPromotionRow,
} from '../domain/pastPlanDetails';
import { assignmentPlanSnapshotId } from './assignment-config';
import { loadPlanPromotionGrantSnapshots } from './assigned-plan-snapshot';
import { membershipFeeBenefitsFromSnapshot } from './membership-promotions';
import { PLAN_LINE_CATEGORIES, PLAN_LINE_TABLE, promotionHolderSql } from './plan-snapshot-lines';

export type MemberPastPlanWithDetails = MemberPastPlan & { details: PastPlanDetails };

const marks = (n: number) => Array.from({ length: n }, () => '?').join(',');

/** Each past plan with the snapshot-only details its expanded card shows. */
export async function attachPastPlanDetails(
  gymId: string,
  past: readonly MemberPastPlan[],
): Promise<MemberPastPlanWithDetails[]> {
  if (past.length === 0) return [];
  const assignmentIds = past.filter((p) => p.product_set_id == null).map((p) => p.id);
  const setIds = past.filter((p) => p.product_set_id != null).map((p) => Number(p.product_set_id));

  // 1. Which plan snapshot each past plan is: the one that names the assignment
  //    (the read every assignment reader uses), or a cancelled set's first link.
  const snapshotByAssignment = new Map<number, number>();
  const snapshotBySet = new Map<number, number>();
  if (assignmentIds.length > 0) {
    const { rows } = await db.query<any>(
      // #2125 M6b-11: grouped off the snapshots themselves rather than `user_memberships`; an
      // assignment no snapshot names had no snapshot to report before either.
      `SELECT ps0.source_user_membership_id AS id,
              ${assignmentPlanSnapshotId('ps0.source_user_membership_id', 'ps0.gym_id')} AS plan_snapshot_id
         FROM plan_snapshots ps0
        WHERE ps0.gym_id = ? AND ps0.source_user_membership_id IN (${marks(assignmentIds.length)})
        GROUP BY ps0.source_user_membership_id, ps0.gym_id`,
      [gymId, ...assignmentIds],
    );
    for (const r of rows) if (r.plan_snapshot_id != null) snapshotByAssignment.set(Number(r.id), Number(r.plan_snapshot_id));
  }
  if (setIds.length > 0) {
    const { rows } = await db.query<any>(
      `SELECT ps.id,
              (SELECT j.plan_snapshot_id FROM product_set_plan_snapshots j
                WHERE j.product_set_id = ps.id ORDER BY j.id LIMIT 1) AS plan_snapshot_id
         FROM product_sets ps
        WHERE ps.gym_id = ? AND ps.id IN (${marks(setIds.length)})`,
      [gymId, ...setIds],
    );
    for (const r of rows) if (r.plan_snapshot_id != null) snapshotBySet.set(Number(r.id), Number(r.plan_snapshot_id));
  }
  const snapshotIds = [...new Set([...snapshotByAssignment.values(), ...snapshotBySet.values()])];

  // 2. The plan snapshots' own agreed fee and cadence.
  const planById = new Map<number, any>();
  // 3. Their lines, from the three line tables in one statement.
  const linesBySnapshot = new Map<number, PastPlanLineRow[]>();
  if (snapshotIds.length > 0) {
    const { rows: plans } = await db.query<any>(
      `SELECT id, membership_fee_price, recurring_billing_interval, recurring_billing_unit
         FROM plan_snapshots WHERE gym_id = ? AND id IN (${marks(snapshotIds.length)})`,
      [gymId, ...snapshotIds],
    );
    for (const p of plans) planById.set(Number(p.id), p);

    const { rows: lines } = await db.query<any>(
      PLAN_LINE_CATEGORIES.map((category) => `
        SELECT plan_snapshot_id, '${category}' AS category, product_id, item_name, item_type,
               item_billing_frequency, quantity, mandatory, \`action\`, \`value\`, direct_discount_percent,
               ${category === 'session' ? 'frequency' : 'NULL'} AS frequency
          FROM ${PLAN_LINE_TABLE[category]}
         WHERE gym_id = ? AND plan_snapshot_id IN (${marks(snapshotIds.length)})`).join(' UNION ALL '),
      PLAN_LINE_CATEGORIES.flatMap(() => [gymId, ...snapshotIds]),
    );
    for (const l of lines as PastPlanLineRow[]) {
      const id = Number(l.plan_snapshot_id);
      const list = linesBySnapshot.get(id) ?? [];
      list.push(l);
      linesBySnapshot.set(id, list);
    }
  }

  // 4. The Promotion applications are the plan snapshot's own `plan_promotion_snapshots` rows
  //    (#3026 stage 3b), read through the snapshot that holds them. Since stage 3c-3 `id` is the
  //    row's own, which its grant rows are keyed by.
  const appsBySnapshot = new Map<number, PastPlanPromotionRow[]>();
  if (snapshotIds.length > 0) {
    const { rows: apps } = await db.query<any>(
      `SELECT pa.id AS plan_snapshot_id, pps.id AS id, pps.status, pps.snapshot,
              pps.applied_at, pps.revoked_at
         FROM plan_snapshots pa
         JOIN plan_promotion_snapshots pps
           ON pps.plan_snapshot_id = ${promotionHolderSql('pa.id')} AND pps.gym_id = pa.gym_id
        WHERE pa.gym_id = ? AND pa.id IN (${marks(snapshotIds.length)})
        ORDER BY pps.applied_at, pps.id`,
      [gymId, ...snapshotIds],
    );
    for (const a of apps) {
      const list = appsBySnapshot.get(Number(a.plan_snapshot_id)) ?? [];
      list.push(a);
      appsBySnapshot.set(Number(a.plan_snapshot_id), list);
    }
  }
  const allApps = [...appsBySnapshot.values()].flat();

  // 5. What each application granted, from its own grant snapshot rows.
  const grants = await loadPlanPromotionGrantSnapshots(gymId, allApps.map((a: any) => Number(a.id)));

  return past.map((plan) => {
    const isSet = plan.product_set_id != null;
    const key = isSet ? Number(plan.product_set_id) : plan.id;
    const snapshotId = (isSet ? snapshotBySet : snapshotByAssignment).get(key);
    const planRow = snapshotId != null ? planById.get(snapshotId) : null;
    const promotions = (appsBySnapshot.get(snapshotId ?? -1) ?? []).map((app) => {
      const granted: PastPlanPromotionGrant[] = (grants.get(Number(app.id)) ?? []).map((g) => ({
        product_name: g.name,
        quantity: g.quantity,
        action: g.benefit.action,
        value: g.benefit.value,
      }));
      return shapePastPlanPromotion(app, membershipFeeBenefitsFromSnapshot(pastPlanPromotionSnapshot(app)), granted);
    });
    if (!planRow && promotions.length === 0) return { ...plan, details: EMPTY_PAST_PLAN_DETAILS };
    return {
      ...plan,
      details: {
        membership_fee_price: planRow?.membership_fee_price != null ? Number(planRow.membership_fee_price) : null,
        billing_interval: planRow?.recurring_billing_interval != null ? Number(planRow.recurring_billing_interval) : null,
        billing_unit: planRow?.recurring_billing_unit ?? null,
        lines: snapshotId != null ? shapePastPlanLines(linesBySnapshot.get(snapshotId) ?? []) : [],
        promotions,
      },
    };
  });
}
