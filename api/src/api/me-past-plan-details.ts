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
import { loadPromotionGrantSnapshots } from './assigned-plan-snapshot';
import { membershipFeeBenefitsFromSnapshot } from './membership-promotions';
import { PLAN_LINE_CATEGORIES, PLAN_LINE_TABLE } from './plan-snapshot-lines';

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
      `SELECT um.id, ${assignmentPlanSnapshotId('um.id', 'um.gym_id')} AS plan_snapshot_id
         FROM user_memberships um
        WHERE um.gym_id = ? AND um.id IN (${marks(assignmentIds.length)})`,
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

  // 4. The Promotion applications: a plan Promotion belongs to the assignment it
  //    was applied to (#1995); a cancelled set that never had one keeps its own.
  //    Line-owned Product Promotions (`recurrent_snapshot_id`) are not the plan's.
  const appsByAssignment = new Map<number, PastPlanPromotionRow[]>();
  const appsBySet = new Map<number, PastPlanPromotionRow[]>();
  const conditions: string[] = [];
  const params: unknown[] = [gymId];
  if (assignmentIds.length > 0) {
    conditions.push(`ump.user_membership_id IN (${marks(assignmentIds.length)})`);
    params.push(...assignmentIds);
  }
  if (setIds.length > 0) {
    conditions.push(`(ump.user_membership_id IS NULL AND ump.product_set_id IN (${marks(setIds.length)}))`);
    params.push(...setIds);
  }
  const { rows: apps } = await db.query<any>(
    `SELECT ump.id, ump.user_membership_id, ump.product_set_id, ump.status, ump.snapshot,
            ump.applied_at, ump.revoked_at
       FROM user_membership_promotions ump
      WHERE ump.gym_id = ? AND ump.recurrent_snapshot_id IS NULL AND (${conditions.join(' OR ')})
      ORDER BY ump.applied_at, ump.id`,
    params,
  );
  for (const a of apps) {
    const target = a.user_membership_id != null ? appsByAssignment : appsBySet;
    const key = Number(a.user_membership_id ?? a.product_set_id);
    const list = target.get(key) ?? [];
    list.push(a);
    target.set(key, list);
  }

  // 5. What each application granted, from its own grant snapshot rows.
  const grants = await loadPromotionGrantSnapshots(gymId, apps.map((a: any) => Number(a.id)));

  return past.map((plan) => {
    const isSet = plan.product_set_id != null;
    const key = isSet ? Number(plan.product_set_id) : plan.id;
    const snapshotId = (isSet ? snapshotBySet : snapshotByAssignment).get(key);
    const planRow = snapshotId != null ? planById.get(snapshotId) : null;
    const promotions = ((isSet ? appsBySet : appsByAssignment).get(key) ?? []).map((app) => {
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
