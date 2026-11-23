/**
 * #1325 PR 3e-2/3e-3 — where an assignment's commercial configuration is read from.
 *
 * An assignment's fee, its Billing & Duration, its Billing frequency, its renewal
 * flag, its negotiated fee's reason and its Personal Membership Fee Benefit are
 * the **ProductSet version linked to it** (`product_sets.user_membership_id`) —
 * the latest one, Draft and closed included, since a closed assignment's
 * configuration is the record of what it billed. The `user_memberships` row
 * carried none of them (migration 258) and migration 458 dropped it: an
 * assignment is its plan snapshots, whose anchor holds its identity and lifecycle.
 *
 * A reader takes a value through `assignmentConfig()` and puts
 * `ASSIGNMENT_CONFIG_JOIN` after its `FROM <assignment rows> um` (`GYM_ASSIGNMENT_ROWS_SQL`, …); a list read as
 * `um.*` (a derived table cannot carry a column twice) overlays them with
 * `withAssignmentConfig()`. The cadence is `ASSIGNMENT_CADENCE`: the version's
 * frozen pair, then its Plan's live policy — never the chain's schedule, which
 * keeps the cadence of the chain's first version.
 */

/** The columns the version's plan snapshot holds under the assignment's own names. */
export type AssignmentConfigColumn =
  | 'membership_fee_price' | 'base_price' | 'plan_price_id'
  | 'discount_reason' | 'discount_expires_at'
  | 'free_periods' | 'paid_periods' | 'bonus_periods' | 'pay_beforehand_periods'
  | 'auto_renew' | 'personal_fee_benefit_action' | 'personal_fee_benefit_value'
  | 'recurring_billing_interval' | 'recurring_billing_unit' | 'origin'
  /** #2834 — the Membership Fee scope frozen onto the assignment's plan snapshot. */
  | 'membership_fee_scope';

/**
 * #1325 PR 3e-4a — SQL for the id of the latest version linked to the assignment
 * `idExpr` (a column or a `?`). The rows an assignment's benefits, applied
 * Promotions and recurring services are read from are that version's own
 * (`product_set_id = <this>`); there is no per-assignment copy of them.
 *
 * #2125 M6b-39 — "linked to the assignment" is the set's anchor (`product_sets.plan_assignment_id`,
 * M6b-36), never `product_sets.user_membership_id`, the column the re-key drops. The caller still
 * names the assignment by its legacy id, read off the anchor snapshot's `anchor_plan_snapshot_id`
 * (the anchor is the lowest snapshot naming that id, so it names exactly it).
 */
export const assignmentVersionId = (idExpr: string) =>
  `(SELECT p9.id FROM product_sets p9
      JOIN plan_snapshots a9 ON a9.id = ${productSetAssignmentSql('p9')} AND a9.gym_id = p9.gym_id
     WHERE a9.anchor_plan_snapshot_id = ${idExpr} ORDER BY p9.id DESC LIMIT 1)`;

/**
 * #2125 stage 15 — the version whose **version-level** lines (recurring Products and services) an
 * assignment reads: `assignmentVersionId()`, except that a still-active assignment whose version
 * was superseded reads none. That is what an assignment looks like after an Add: its plan moved
 * into the successor version, whose own assignment now carries the lines, so reading them from
 * both would count each line (and its sessions) twice. A closed assignment keeps its own version's
 * lines, as the record of what it billed.
 *
 * #2125 M6b-26 — the assignment's status is its current plan snapshot's, never the `user_memberships` row's.
 * #2125 M6b-37 — that snapshot is found through the set's own anchor (`p9.plan_assignment_id`,
 * `assignmentOfAnchorSql()`), not through `product_sets.user_membership_id`.
 * #2125 M6b-39 — and the set is picked by that anchor too: the anchor's
 * `anchor_plan_snapshot_id` is the legacy id, so `u9` (an assignment's snapshots share its
 * `anchor_plan_snapshot_id`) names it exactly.
 */
export const assignmentLineVersionId = (idExpr: string) =>
  `(SELECT p9.id FROM product_sets p9
      JOIN plan_snapshots u9 ON u9.gym_id = p9.gym_id AND ${assignmentOfAnchorSql(productSetAssignmentSql('p9'), 'u9')}
     WHERE u9.anchor_plan_snapshot_id = ${idExpr} AND NOT (u9.status = 'active' AND p9.status = 'superseded')
     ORDER BY p9.id DESC LIMIT 1)`;

/**
 * #2125 stage 10 — SQL for the id of the plan snapshot an assignment is the contract of: the
 * latest `plan_snapshots` row naming it (`anchor_plan_snapshot_id`), whichever version holds it.
 * A version holds several plans now, so "the version linked to the assignment" no longer says
 * which plan is meant; the snapshot does. Draft and closed included, as before.
 */
export const assignmentPlanSnapshotId = (idExpr: string, gymExpr?: string) =>
  `(SELECT s9.id FROM product_set_plan_snapshots j9 JOIN plan_snapshots s9 ON s9.id = j9.plan_snapshot_id
     JOIN product_sets p9 ON p9.id = j9.product_set_id
     WHERE s9.anchor_plan_snapshot_id = ${idExpr}${gymExpr ? ` AND s9.gym_id = ${gymExpr}` : ''}
     ORDER BY p9.id DESC, s9.id DESC LIMIT 1)`;

/**
 * #2125 M6b-12 — SQL for the id of the plan snapshot an assignment's **configuration and pricing**
 * are read from: its current snapshot (`currentAssignmentSnapshotSql()`, the owner's Active set's
 * first, else the latest set's), never a copy an uncommitted Draft or Pending Payment set owns.
 * While a Draft links a copy of a running plan, the fee, Billing & Duration and cadence the member,
 * the Admin and the nightly run see stay the Active set's (Oscar, 2026-11-15). A Draft is still read
 * where it is the subject: its editor, forecast and review address its own set, and `⋮ → Edit` on a
 * running plan opens a Draft assignment of its own, whose current snapshot is the Draft's.
 *
 * One legacy id is exactly one `anchor_plan_snapshot_id` (M6b-1). The fallback to `assignmentPlanSnapshotId()`
 * covers a snapshot not yet stamped inside the transaction that wrote it; `plan-assignments:validate`
 * reports one left unstamped. Writers keep owning the snapshot through `assignmentPlanSnapshotId()`.
 */
export const assignmentConfigSnapshotId = (idExpr: string, gymExpr: string) =>
  `COALESCE(${currentAssignmentSnapshotSql(
    `(SELECT cla.anchor_plan_snapshot_id FROM plan_snapshots cla
       WHERE cla.anchor_plan_snapshot_id = ${idExpr} AND cla.gym_id = ${gymExpr}
         AND cla.anchor_plan_snapshot_id IS NOT NULL ORDER BY cla.id LIMIT 1)`, gymExpr)},
    ${assignmentPlanSnapshotId(idExpr, gymExpr)})`;

/** Joins the assignment's plan snapshot (its current one, M6b-12) as `cfg`. */
export const ASSIGNMENT_CONFIG_JOIN = (um = 'um') => `
  LEFT JOIN plan_snapshots cfg ON cfg.id = ${assignmentConfigSnapshotId(`${um}.id`, `${um}.gym_id`)}`;

/** The version's value when the assignment has one, its own cached value otherwise. */
export const assignmentConfig = (column: AssignmentConfigColumn, _um = 'um') => `cfg.${column}`;

import { db } from '../infra/db';
import { assignmentOfAnchorSql, currentAssignmentSnapshotSql, GYM_ASSIGNMENT_ROWS_SQL, productSetAssignmentSql } from '../domain/planAssignments';

const OVERLAID: AssignmentConfigColumn[] = [
  'membership_fee_price', 'base_price', 'plan_price_id', 'discount_reason', 'discount_expires_at',
  'free_periods', 'paid_periods', 'bonus_periods', 'pay_beforehand_periods', 'auto_renew',
  'personal_fee_benefit_action', 'personal_fee_benefit_value',
  'recurring_billing_interval', 'recurring_billing_unit', 'origin', 'membership_fee_scope',
];

/**
 * Overlays the version's configuration onto assignment rows read as `um.*`
 * (a list is a derived table, which cannot carry a column twice, so the
 * overlay is a second, batched read — one statement for a whole page). Since #2125 M6b-20 the
 * assignment is read from its current plan snapshot (`GYM_ASSIGNMENT_ROWS_SQL`), never
 * `user_memberships`; a row with no snapshot keeps the values it was read with.
 */
export async function withAssignmentConfig<T extends { id: number | string }>(
  gymId: string, rows: T[],
): Promise<T[]> {
  if (rows.length === 0) return rows;
  const ids = rows.map((r) => Number(r.id));
  const { rows: cfgRows } = await db.query<any>(
    `SELECT um.id, ${OVERLAID.map((c) => `${assignmentConfig(c)} AS ${c}`).join(', ')}
       FROM ${GYM_ASSIGNMENT_ROWS_SQL} um${ASSIGNMENT_CONFIG_JOIN()}
      WHERE um.id IN (${ids.map(() => '?').join(',')})`,
    [gymId, ...ids],
  );
  const byId = new Map<number, any>(cfgRows.map((r) => [Number(r.id), r]));
  return rows.map((r) => {
    const cfg = byId.get(Number(r.id));
    if (!cfg) return r;
    const { id: _id, ...values } = cfg;
    return { ...r, ...values };
  });
}
