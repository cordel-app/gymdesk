// #3026 stage 3d-1 — test fixture only. A Membership Plan Promotion application is its plan
// snapshot's own row (`plan_promotion_snapshots`), and production writes no
// `user_membership_promotions` row for it any more. Tests written against the legacy shape
// ("the applications of this assignment / this Product Set") read these derived tables instead,
// which present the plan snapshot rows under the legacy column names, beside the legacy rows that
// have no plan snapshot twin (rows a fixture seeded by hand). #3026 stage 3d-3c: a line-owned
// Product-target application is its line's Product snapshot row, presented the same way (its id is
// `COALESCE(source_application_id, id)`, its line the legacy line id).

const APPLICATION_COLUMNS = (setExpr: string) => `
  pps.id, pps.gym_id, pps.promotion_id, pps.applied_by, pps.applied_at, pps.consumed_at, pps.status,
  pps.snapshot, pps.revoked_at, ${setExpr} AS product_set_id, pps.modified_at, pps.modified_by,
  pps.created_by, s.source_user_membership_id AS user_membership_id, NULL AS recurrent_snapshot_id,
  pps.snapshot_confirmed_at, s.assignment_id`;

const LEGACY_ONLY = `
  SELECT ump.id, ump.gym_id, ump.promotion_id, ump.applied_by, ump.applied_at, ump.consumed_at, ump.status,
         ump.snapshot, ump.revoked_at, ump.product_set_id, ump.modified_at, ump.modified_by,
         ump.created_by, ump.user_membership_id, ump.recurrent_snapshot_id,
         ump.snapshot_confirmed_at, ump.assignment_id
    FROM user_membership_promotions ump
   WHERE NOT EXISTS (SELECT 1 FROM plan_promotion_snapshots tw WHERE tw.source_id = ump.id)
     AND NOT EXISTS (SELECT 1 FROM product_promotion_snapshots tp WHERE tp.source_application_id = ump.id)
  UNION ALL
  SELECT COALESCE(pp.source_application_id, pp.id), pp.gym_id, pp.promotion_id, pp.applied_by, pp.applied_at,
         pp.consumed_at, pp.status, pp.snapshot, pp.revoked_at, pp.product_set_id, pp.modified_at, pp.modified_by,
         pp.created_by, NULL, par.source_id, pp.snapshot_confirmed_at, NULL
    FROM product_promotion_snapshots pp
    JOIN product_periodical_snapshots par ON par.id = pp.product_periodical_snapshot_id`;

/** One row per application: `product_set_id` is the latest Product Set linking its plan snapshot. */
export const TEST_PLAN_APPLICATIONS = `(
  SELECT ${APPLICATION_COLUMNS('(SELECT MAX(j.product_set_id) FROM product_set_plan_snapshots j WHERE j.plan_snapshot_id = s.id)')}
    FROM plan_promotion_snapshots pps JOIN plan_snapshots s ON s.id = pps.plan_snapshot_id
  UNION ALL ${LEGACY_ONLY})`;

/** One row per application and Product Set linking its plan snapshot (for a read by `product_set_id`). */
export const TEST_PLAN_APPLICATIONS_BY_SET = `(
  SELECT ${APPLICATION_COLUMNS('j.product_set_id')}
    FROM plan_promotion_snapshots pps JOIN plan_snapshots s ON s.id = pps.plan_snapshot_id
    JOIN product_set_plan_snapshots j ON j.plan_snapshot_id = s.id
  UNION ALL ${LEGACY_ONLY})`;

const GRANT_COLUMNS = 'gym_id, product_id, product_name, quantity, item_type, item_billing_frequency, unit_price, currency, `action`, `value`, requirement, created_at';

/** The grant rows of an application, under the legacy table's column names. */
export const TEST_PLAN_APPLICATION_GRANTS = (kind: 'session' | 'oneoff' | 'periodical'): string => `(
  SELECT g.id, g.plan_promotion_snapshot_id AS user_membership_promotion_id, ${GRANT_COLUMNS}
    FROM plan_promotion_${kind}_product_snapshots g
  UNION ALL
  SELECT l.id, l.user_membership_promotion_id, ${GRANT_COLUMNS}
    FROM user_membership_promotion_${kind}_snapshot l
   WHERE NOT EXISTS (SELECT 1 FROM plan_promotion_snapshots tw WHERE tw.source_id = l.user_membership_promotion_id)
     AND NOT EXISTS (SELECT 1 FROM product_promotion_snapshots tp WHERE tp.source_application_id = l.user_membership_promotion_id)
  UNION ALL
  SELECT g.id, COALESCE(pp.source_application_id, pp.id), g.${GRANT_COLUMNS.split(', ').join(', g.').replace('g.`action`', 'g.`action`')}
    FROM product_promotion_grant_snapshots g
    JOIN product_promotion_snapshots pp ON pp.id = g.product_promotion_snapshot_id
   WHERE g.grant_kind = '${kind}' AND pp.product_periodical_snapshot_id IS NOT NULL)`;

/** Rewrites a SELECT written against the legacy tables onto the derived tables above. */
export function rewriteLegacyPromotionSelect(sql: string): string {
  const bySet = /\bproduct_set_id\b/.test(sql);
  let out = sql.replace(/\buser_membership_promotion_(session|oneoff|periodical)_snapshot\b(\s+(?!WHERE\b|JOIN\b|ON\b|ORDER\b|GROUP\b|LEFT\b)(\w+))?/gi,
    (_m, kind, _rest, alias) => `${TEST_PLAN_APPLICATION_GRANTS(kind)} ${alias ?? `umpg_${kind}`}`);
  out = out.replace(/\buser_membership_promotions\b(\s+(?!WHERE\b|JOIN\b|ON\b|ORDER\b|GROUP\b|LEFT\b)(\w+))?/gi,
    (_m, _rest, alias) => `${bySet ? TEST_PLAN_APPLICATIONS_BY_SET : TEST_PLAN_APPLICATIONS} ${alias ?? 'ump_t'}`);
  return out;
}
