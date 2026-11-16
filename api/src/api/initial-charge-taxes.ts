// #2947 — the SQL half of `domain/initialChargeTaxes.ts`: the rates a ProductSet's
// initial charge lines are taxed at, read from the plans and Products the set carries.
import { db, Tx } from '../infra/db';
import type { InitialChargeTaxRates } from '../domain/initialChargeTaxes';

type Exec = Pick<Tx, 'query'> | typeof db;

const rateOf = (v: unknown): number | null => (v == null ? null : Number(v));

export async function loadInitialChargeTaxRates(
  exec: Exec, gymId: string, productSetId: number, productIds: number[],
): Promise<InitialChargeTaxRates> {
  const { rows: sys } = await exec.query<any>(
    `SELECT rate_percent FROM tax_rates
      WHERE gym_id = ? AND is_system = 1 AND deleted_at IS NULL
      ORDER BY id LIMIT 1`, [gymId]);
  const system = rateOf(sys[0]?.rate_percent);

  // A Membership Fee line is keyed as `loadProductSetSimulationAssignments()` keys its
  // assignment: the set's id for its first plan snapshot, the snapshot's id for any other,
  // and the set's id for a version with no plan snapshot (its own `membership_plan_id`).
  const { rows: plans } = await exec.query<any>(
    `SELECT s.id, tr.rate_percent
       FROM product_set_plan_snapshots psj
       JOIN plan_snapshots s ON s.id = psj.plan_snapshot_id
       LEFT JOIN membership_plans mp ON mp.id = s.membership_plan_id
       LEFT JOIN tax_rates tr ON tr.id = mp.tax_rate_id AND tr.gym_id = s.gym_id
      WHERE s.gym_id = ? AND psj.product_set_id = ? AND psj.entitlement_only = 0
      ORDER BY psj.id`, [gymId, productSetId]);
  const byFeeKey = new Map<number, number | null>();
  if (plans.length > 0) {
    plans.forEach((p: any, i: number) => byFeeKey.set(i === 0 ? productSetId : Number(p.id), rateOf(p.rate_percent)));
  } else {
    const { rows: own } = await exec.query<any>(
      `SELECT tr.rate_percent
         FROM product_sets ps
         LEFT JOIN membership_plans mp ON mp.id = ps.membership_plan_id
         LEFT JOIN tax_rates tr ON tr.id = mp.tax_rate_id AND tr.gym_id = ps.gym_id
        WHERE ps.id = ? AND ps.gym_id = ?`, [productSetId, gymId]);
    byFeeKey.set(productSetId, rateOf(own[0]?.rate_percent));
  }

  const byProduct = new Map<number, number | null>();
  const ids = [...new Set(productIds)];
  if (ids.length > 0) {
    const { rows } = await exec.query<any>(
      `SELECT p.id, tr.rate_percent
         FROM products p LEFT JOIN tax_rates tr ON tr.id = p.tax_rate_id AND tr.gym_id = p.gym_id
        WHERE p.gym_id = ? AND p.id IN (${ids.map(() => '?').join(',')})`, [gymId, ...ids]);
    for (const r of rows) byProduct.set(Number(r.id), rateOf(r.rate_percent));
  }
  return { system, byFeeKey, byProduct };
}
