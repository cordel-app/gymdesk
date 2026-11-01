/**
 * #1325 PR 3e-2/3e-3 — where an assignment's commercial configuration is read from.
 *
 * An assignment's fee, its Billing & Duration, its Billing frequency, its renewal
 * flag, its negotiated fee's reason and its Personal Membership Fee Benefit are
 * the **ProductSet version linked to it** (`product_sets.user_membership_id`) —
 * the latest one, Draft and closed included, since a closed assignment's
 * configuration is the record of what it billed. The `user_memberships` row
 * carries none of them (migration 258): it is the assignment's identity, dates
 * and status.
 *
 * A reader takes a value through `assignmentConfig()` and puts
 * `ASSIGNMENT_CONFIG_JOIN` after its `FROM user_memberships um`; a list read as
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
  | 'recurring_billing_interval' | 'recurring_billing_unit' | 'origin';

/**
 * #1325 PR 3e-4a — SQL for the id of the latest version linked to the assignment
 * `idExpr` (a column or a `?`). The rows an assignment's benefits, applied
 * Promotions and recurring services are read from are that version's own
 * (`product_set_id = <this>`); there is no per-assignment copy of them.
 */
export const assignmentVersionId = (idExpr: string) =>
  `(SELECT p9.id FROM product_sets p9 WHERE p9.user_membership_id = ${idExpr} ORDER BY p9.version DESC, p9.id DESC LIMIT 1)`;

/**
 * #2125 stage 10 — SQL for the id of the plan snapshot an assignment is the contract of: the
 * latest `plan_snapshots` row naming it (`source_user_membership_id`), whichever version holds it.
 * A version holds several plans now, so "the version linked to the assignment" no longer says
 * which plan is meant; the snapshot does. Draft and closed included, as before.
 */
export const assignmentPlanSnapshotId = (idExpr: string, gymExpr?: string) =>
  `(SELECT s9.id FROM plan_snapshots s9 JOIN product_sets p9 ON p9.id = s9.product_set_id
     WHERE s9.source_user_membership_id = ${idExpr}${gymExpr ? ` AND s9.gym_id = ${gymExpr}` : ''}
     ORDER BY p9.version DESC, s9.id DESC LIMIT 1)`;

/** Joins the assignment's plan snapshot as `cfg`. */
export const ASSIGNMENT_CONFIG_JOIN = (um = 'um') => `
  LEFT JOIN plan_snapshots cfg ON cfg.id = ${assignmentPlanSnapshotId(`${um}.id`, `${um}.gym_id`)}`;

/** The version's value when the assignment has one, its own cached value otherwise. */
export const assignmentConfig = (column: AssignmentConfigColumn, _um = 'um') => `cfg.${column}`;

import { db } from '../infra/db';

const OVERLAID: AssignmentConfigColumn[] = [
  'membership_fee_price', 'base_price', 'plan_price_id', 'discount_reason', 'discount_expires_at',
  'free_periods', 'paid_periods', 'bonus_periods', 'pay_beforehand_periods', 'auto_renew',
  'personal_fee_benefit_action', 'personal_fee_benefit_value',
  'recurring_billing_interval', 'recurring_billing_unit', 'origin',
];

/**
 * Overlays the version's configuration onto assignment rows read as `um.*`
 * (a list is a derived table, which cannot carry a column twice, so the
 * overlay is a second, batched read — one statement for a whole page).
 */
export async function withAssignmentConfig<T extends { id: number | string }>(
  gymId: string, rows: T[],
): Promise<T[]> {
  if (rows.length === 0) return rows;
  const ids = rows.map((r) => Number(r.id));
  const { rows: cfgRows } = await db.query<any>(
    `SELECT um.id, ${OVERLAID.map((c) => `${assignmentConfig(c)} AS ${c}`).join(', ')}
       FROM user_memberships um${ASSIGNMENT_CONFIG_JOIN()}
      WHERE um.gym_id = ? AND um.id IN (${ids.map(() => '?').join(',')})`,
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
