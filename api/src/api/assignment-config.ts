/**
 * #1325 PR 3e-2 — where an assignment's commercial configuration is read from.
 *
 * An assignment's fee, its Billing & Duration, its renewal flag, its negotiated
 * fee's reason and its Personal Membership Fee Benefit are the **ProductSet
 * version linked to it** (`product_sets.user_membership_id`) — the latest one,
 * Draft and closed included, since a closed assignment's configuration is the
 * record of what it billed. The same values still sit on the `user_memberships`
 * row as a cache the projection writes; a row **with no version** (written
 * before ProductSets, or a legacy Draft) has nothing else, so it reads its own.
 *
 * A reader of those columns takes them through `assignmentConfig()` and puts
 * `ASSIGNMENT_CONFIG_JOIN` after its `FROM user_memberships um`, so the row it
 * prices from is the version's, and the cache can be dropped without a reader
 * noticing. The cadence is deliberately not here: it is read through
 * `ASSIGNMENT_CADENCE` (the assignment's frozen pair, then its Plan's), because
 * a chain's schedule may carry an earlier plan's cadence.
 */

/** The columns the version's plan snapshot holds under the assignment's own names. */
export type AssignmentConfigColumn =
  | 'membership_fee_price' | 'base_price' | 'plan_price_id'
  | 'discount_reason' | 'discount_expires_at'
  | 'free_periods' | 'paid_periods' | 'bonus_periods' | 'pay_beforehand_periods'
  | 'auto_renew' | 'personal_fee_benefit_action' | 'personal_fee_benefit_value';

/** Joins the latest linked version and its plan snapshot as `cfg_ps` / `cfg`. */
export const ASSIGNMENT_CONFIG_JOIN = (um = 'um') => `
  LEFT JOIN product_sets cfg_ps ON cfg_ps.id = (
        SELECT p9.id FROM product_sets p9
         WHERE p9.gym_id = ${um}.gym_id AND p9.user_membership_id = ${um}.id
         ORDER BY p9.version DESC, p9.id DESC LIMIT 1)
  LEFT JOIN product_set_plan_snapshots cfg ON cfg.product_set_id = cfg_ps.id`;

/** The version's value when the assignment has one, its own cached value otherwise. */
export const assignmentConfig = (column: AssignmentConfigColumn, um = 'um') =>
  `IF(cfg.product_set_id IS NULL, ${um}.${column}, cfg.${column})`;

import { db } from '../infra/db';

const OVERLAID: AssignmentConfigColumn[] = [
  'membership_fee_price', 'base_price', 'plan_price_id', 'discount_reason', 'discount_expires_at',
  'free_periods', 'paid_periods', 'bonus_periods', 'pay_beforehand_periods', 'auto_renew',
  'personal_fee_benefit_action', 'personal_fee_benefit_value',
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
