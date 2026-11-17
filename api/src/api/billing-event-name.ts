// #2940 — the SQL half of a Billing Event's name: reads the facts
// `domain/billingEventName.ts` decides from. Each writer calls one of these in
// the transaction that inserts the event and stores the answer in
// `billing_events.name`; nothing here writes.

import { Tx } from '../infra/db';
import { planSnapshotInheritedSql } from './plan-snapshot-lines';
import { recurringLineInheritedSql } from './recurring-line-sharing';
import { chargeableSetPurchases } from './set-purchases';
import { initialEventName, purchaseEventName, recurringEventName } from '../domain/billingEventName';

type Exec = { query: Tx['query'] };

export async function loadGymName(exec: Exec, gymId: string): Promise<string> {
  const { rows } = await exec.query<{ name: string | null }>('SELECT name FROM gyms WHERE id = ?', [gymId]);
  return String(rows[0]?.name ?? '');
}

/**
 * The name of a ProductSet version's initial event: what the version adds
 * relative to its predecessor (its own plans and recurring lines, plus the
 * one-time Products of its cart), and whether it is the member's first
 * engagement or modifies a plan they already hold.
 */
export async function initialEventNameFor(
  exec: Exec, gymId: string, productSetId: number, purchaseDate: string,
  /** #2949 stage 5: the standalone cart purchases the same checkout pays. */
  cartProductNames: string[] = [],
): Promise<string> {
  const { rows: setRows } = await exec.query<{ previous_product_set_id: number | null }>(
    'SELECT previous_product_set_id FROM product_sets WHERE id = ? AND gym_id = ?', [productSetId, gymId]);
  const previousId = setRows[0]?.previous_product_set_id != null ? Number(setRows[0].previous_product_set_id) : null;

  // The version's billable plans, each with whether it carries over from the predecessor
  // and whether it is an edited copy of one it carried (a modification).
  const { rows: plans } = await exec.query<any>(
    `SELECT s.id, mp.name AS plan_name, s.copied_from_plan_snapshot_id,
            ${planSnapshotInheritedSql('s', 'psj.product_set_id')} AS inherited
       FROM product_set_plan_snapshots psj
       JOIN plan_snapshots s ON s.id = psj.plan_snapshot_id
       LEFT JOIN membership_plans mp ON mp.id = s.membership_plan_id
      WHERE s.gym_id = ? AND psj.product_set_id = ? AND psj.entitlement_only = 0`,
    [gymId, productSetId]);

  let removesPlan = false;
  if (previousId != null) {
    // A plan the predecessor billed that this version no longer carries (unchanged or as a copy):
    // a replacement or a removal, which is a modification of the member's plans.
    const { rows: gone } = await exec.query<{ n: number }>(
      `SELECT COUNT(*) AS n
         FROM product_set_plan_snapshots pj
        WHERE pj.product_set_id = ? AND pj.entitlement_only = 0
          AND NOT EXISTS (
            SELECT 1 FROM product_set_plan_snapshots cj JOIN plan_snapshots cs ON cs.id = cj.plan_snapshot_id
             WHERE cj.product_set_id = ? AND cj.entitlement_only = 0
               AND (cs.id = pj.plan_snapshot_id OR cs.copied_from_plan_snapshot_id = pj.plan_snapshot_id))`,
      [previousId, productSetId]);
    removesPlan = Number(gone[0]?.n ?? 0) > 0;
  }

  const { rows: lines } = await exec.query<any>(
    `SELECT l.product_name
       FROM product_set_periodical_snapshots j
       JOIN product_periodical_snapshots l ON l.id = j.product_periodical_snapshot_id
      WHERE j.product_set_id = ? AND l.gym_id = ? AND l.ends_at IS NULL
        AND NOT ${recurringLineInheritedSql('l', 'j.product_set_id')}`,
    [productSetId, gymId]);
  const purchases = await chargeableSetPurchases(exec, gymId, productSetId);

  const addedPlans = plans.filter((p: any) => Number(p.inherited) === 0).map((p: any) => String(p.plan_name ?? ''));
  const editedPlan = plans.some((p: any) => Number(p.inherited) === 1 && p.copied_from_plan_snapshot_id != null);

  return initialEventName({
    gymName: await loadGymName(exec, gymId),
    purchaseDate,
    // An Add (#2125 stage 14) is a version with no predecessor that carries the running plans as
    // inherited copies: it is a purchase of the added plan, not a first engagement.
    firstEngagement: previousId == null && plans.length > 0 && plans.every((p: any) => Number(p.inherited) === 0),
    modifiesPlan: previousId != null && (editedPlan || removesPlan),
    added: {
      plans: addedPlans,
      products: [...lines.map((l: any) => String(l.product_name)), ...purchases.map((p) => p.product_name), ...cartProductNames],
    },
  });
}

/** A recurring obligation's name, from its schedule's cadence and its billing date. */
export async function recurringEventNameFor(
  exec: Exec, gymId: string, scheduleId: number | null, billingDate: string,
): Promise<string> {
  let cadence: { interval: number; unit: string } | null = null;
  if (scheduleId != null) {
    const { rows } = await exec.query<any>(
      'SELECT cadence_interval, cadence_unit FROM product_set_schedules WHERE id = ?', [scheduleId]);
    if (rows[0]) cadence = { interval: Number(rows[0].cadence_interval), unit: String(rows[0].cadence_unit) };
  }
  return recurringEventName({ gymName: await loadGymName(exec, gymId), billingDate, cadence });
}

/** A one-time purchase outside a ProductSet (§4.1): `Gym - Product Name`. */
export async function productPurchaseEventNameFor(
  exec: Exec, gymId: string, productName: string, purchaseDate: string,
): Promise<string> {
  return purchaseEventName({
    gymName: await loadGymName(exec, gymId), purchaseDate, items: { plans: [], products: [productName] },
  });
}

/**
 * #2949 stage 4 — a cart checkout of several standalone one-time purchases (no ProductSet):
 * `Gym - Product Name` for one, `Gym - Compra dd/mm/yyyy` for several (§4.1's purchase rule).
 */
export async function cartPurchaseEventNameFor(
  exec: Exec, gymId: string, productNames: string[], purchaseDate: string,
): Promise<string> {
  return purchaseEventName({
    gymName: await loadGymName(exec, gymId), purchaseDate, items: { plans: [], products: productNames },
  });
}
