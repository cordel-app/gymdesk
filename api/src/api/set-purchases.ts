/**
 * #2746 stage 1 — one-time Products in a member's shopping cart.
 *
 * The cart is the member's Draft Product Set (#2496). A recurring Product is a line of it; a
 * one-time Product (a Sessions package included) stays what #1657 made it — a `draft` purchase
 * (`member_products_oneoff_snapshot` + its Product snapshot) — and is **linked** to the Draft
 * through the `product_set_{oneoff,session}_snapshots` junction (migration 366; since #2126 stage 6b,
 * migration 417, the snapshot names no set of its own). From then on it moves with the set,
 * and only with the set, through the functions below, each called from the one place the set
 * moves:
 *
 *   initial charge   `initialCharge()` adds one line per linked purchase, at its frozen amount
 *   Save & Pay       `submitForPayment()`      draft           → pending_payment
 *   initial event    `ensureInitialEvent()`    the purchase snapshots join the event's junction,
 *                                             so each purchase reaches its payment as any purchase does
 *   activation       `activate()`              draft | pending → active (purchased_at, valid_until)
 *   back to Draft    `returnPendingToDraft()`  pending_payment → draft
 *   discard          `deleteProductSetAndOwnPlanSnapshots()` deletes them with the set
 *
 * A linked purchase is never paid on its own: the cleanup that cancels an abandoned purchase skips
 * it (`purchaseSnapshotsSql(…, { notInProductSet: true })`), and its amount is the one `resolvePurchase()` froze — nothing here
 * prices anything.
 */
import { DateTime } from 'luxon';
import type { Tx } from '../infra/db';
import { SYSTEM_ACTOR } from '../domain/auditActor';
import { computeValidUntil } from '../domain/productValidity';
import { resolveTimeZone } from '../domain/homeDashboard';
import { deletePurchase, updatePurchase } from './purchase-writer';
import { PURCHASE_EVENT_JUNCTIONS } from './snapshot-junction-sync';
import type { SimulationLine } from '../domain/billingSimulation';
import type { BillingEventLineRow } from '../domain/billingEventLines';
import { lineFromSimulation } from '../domain/billingEventLines';

type Conn = Pick<Tx, 'query'>;

const ARMS = [
  { table: 'product_oneoff_snapshots', setJunction: 'product_set_oneoff_snapshots', snapshotCol: 'product_oneoff_snapshot_id' },
  { table: 'product_session_snapshots', setJunction: 'product_set_session_snapshots', snapshotCol: 'product_session_snapshot_id' },
] as const;

export interface SetPurchase {
  /** The purchase id (`source_id`), the id every purchase route is keyed on. */
  id: number;
  snapshot_id: number;
  snapshot_table: (typeof ARMS)[number]['table'];
  member_id: number;
  product_id: number | null;
  product_name: string;
  product_type: string | null;
  units: number | null;
  status: string;
  amount: number;
  list_price: number | null;
  currency: string | null;
  tax_rate_percent: number | null;
  assigned_member_id: number | null;
  validity_days: number | null;
  billing_frequency: string | null;
  description: string | null;
  image_url: string | null;
  image_thumbnail_url: string | null;
}

/** The one-time purchases linked to a Product Set, in the order they were added. */
export async function loadSetPurchases(exec: Conn, gymId: string, productSetId: number): Promise<SetPurchase[]> {
  const out: { p: SetPurchase; created: number }[] = [];
  for (const arm of ARMS) {
    const { rows } = await exec.query<any>(
      `SELECT s.source_id AS id, s.id AS snapshot_id, s.member_id, s.product_id, s.product_name, s.product_type,
              s.units, s.status, s.unit_price AS amount, s.list_price, s.currency, s.tax_rate_percent,
              s.assigned_member_id, s.validity_days, s.billing_frequency, s.created_at,
              p.description, p.image_url, p.image_thumbnail_url
         FROM ${arm.setJunction} j
         JOIN ${arm.table} s ON s.id = j.${arm.snapshotCol} AND s.gym_id = ?
         LEFT JOIN products p ON p.id = s.product_id AND p.gym_id = s.gym_id
        WHERE j.product_set_id = ? AND s.source_id IS NOT NULL`,
      [gymId, productSetId]);
    for (const r of rows) {
      out.push({ created: new Date(r.created_at).getTime() || 0, p: {
        id: Number(r.id), snapshot_id: Number(r.snapshot_id), snapshot_table: arm.table,
        member_id: Number(r.member_id),
        product_id: r.product_id == null ? null : Number(r.product_id),
        product_name: String(r.product_name), product_type: r.product_type ?? null,
        units: r.units == null ? null : Number(r.units), status: String(r.status),
        amount: Number(r.amount ?? 0), list_price: r.list_price == null ? null : Number(r.list_price),
        currency: r.currency ?? null, tax_rate_percent: r.tax_rate_percent == null ? null : Number(r.tax_rate_percent),
        assigned_member_id: r.assigned_member_id == null ? null : Number(r.assigned_member_id),
        validity_days: r.validity_days == null ? null : Number(r.validity_days),
        billing_frequency: r.billing_frequency ?? null,
        description: r.description ?? null, image_url: r.image_url ?? null,
        image_thumbnail_url: r.image_thumbnail_url ?? r.image_url ?? null,
      } });
    }
  }
  return out.sort((a, b) => (a.created - b.created) || a.p.id - b.p.id).map((x) => x.p);
}

/** Links a purchase (written as a draft in the same transaction) to the Draft Product Set. */
export async function linkPurchaseToSet(tx: Conn, gymId: string, purchaseId: number, productSetId: number): Promise<void> {
  for (const arm of ARMS) {
    await tx.query(
      `INSERT IGNORE INTO ${arm.setJunction} (product_set_id, ${arm.snapshotCol})
       SELECT ?, s.id FROM ${arm.table} s WHERE s.gym_id = ? AND s.source_id = ?`,
      [productSetId, gymId, purchaseId]);
  }
}

/** Removes a draft purchase from the Draft (a hard delete: a draft has charged nothing). */
export async function removeSetPurchase(tx: Conn, gymId: string, productSetId: number, purchaseId: number): Promise<boolean> {
  const p = (await loadSetPurchases(tx, gymId, productSetId)).find((x) => x.id === purchaseId);
  if (!p || p.status !== 'draft') return false;
  return deletePurchase(tx, gymId, purchaseId, { memberId: p.member_id, status: 'draft' });
}

const ER_DUP_ENTRY = 1062;

/** Moves every linked purchase still `from` to `to` (Save & Pay, back to Draft). */
export async function moveSetPurchases(tx: Conn, gymId: string, productSetId: number, from: string, to: string): Promise<void> {
  for (const p of await loadSetPurchases(tx, gymId, productSetId)) {
    if (p.status !== from) continue;
    try {
      await updatePurchase(tx, gymId, p.id, { status: to }, SYSTEM_ACTOR, { fromStatus: from });
    } catch (err: any) {
      // The legacy record's pending key: the member already has this Product awaiting payment.
      if (err?.errno === ER_DUP_ENTRY) throw Object.assign(new Error('purchase_pending'), { status: 409 });
      throw err;
    }
  }
}

/** The purchases become the member's when their set does (the webhook's activation, or a free commit). */
export async function activateSetPurchases(tx: Conn, gymId: string, productSetId: number): Promise<void> {
  const purchases = (await loadSetPurchases(tx, gymId, productSetId))
    .filter((p) => p.status === 'draft' || p.status === 'pending_payment');
  if (purchases.length === 0) return;
  const { rows } = await tx.query<{ time_zone: string | null }>('SELECT time_zone FROM gyms WHERE id = ?', [gymId]);
  // #1693: the purchase day is the gym's calendar day of the confirmation.
  const purchasedOn = DateTime.now().setZone(resolveTimeZone(rows[0]?.time_zone ?? null)).toISODate()!;
  for (const p of purchases) {
    const validUntil = computeValidUntil({ purchasedOn, validityDays: p.validity_days, billingFrequency: p.billing_frequency });
    await updatePurchase(tx, gymId, p.id, { status: 'active', purchasedAt: new Date(), validUntil },
      SYSTEM_ACTOR, { fromStatus: p.status });
  }
}

/** Deletes the purchases a Product Set being deleted (a Draft or an unpaid checkout) still holds. */
export async function deleteSetPurchases(tx: Conn, gymId: string, productSetId: number, status: 'draft' | 'pending_payment'): Promise<void> {
  for (const p of await loadSetPurchases(tx, gymId, productSetId)) {
    if (p.status !== status) continue;
    await deletePurchase(tx, gymId, p.id, { memberId: p.member_id, status });
  }
}

/** Links the set's purchases to its initial Billing Event, so each reaches its payment (#2126 stage 5a). */
export async function linkSetPurchasesToEvent(tx: Conn, gymId: string, productSetId: number, billingEventId: number): Promise<void> {
  for (const p of await loadSetPurchases(tx, gymId, productSetId)) {
    const j = PURCHASE_EVENT_JUNCTIONS.find((x) => x.table === p.snapshot_table)!;
    await tx.query(`INSERT IGNORE INTO ${j.junction} (billing_event_id, ${j.snapshotCol}) VALUES (?, ?)`,
      [billingEventId, p.snapshot_id]);
  }
}

/**
 * The initial charge's line for a linked purchase: its frozen amount, restated (never priced here).
 * The regular price is the purchase's list price, and the treatment says a discount was applied.
 */
export function purchaseChargeLine(p: SetPurchase): { simulation: SimulationLine; line: BillingEventLineRow } {
  const regular = p.list_price ?? p.amount;
  const simulation: SimulationLine = {
    kind: 'product', label: p.product_name, user_membership_id: 0, plan_name: null,
    product_id: p.product_id, quantity: 1, unit_price: p.amount, regular_price: regular,
    benefits: [], actual_charge: p.amount, price_may_change: false, prepaid_periods: null,
  };
  const line = {
    ...lineFromSimulation(simulation, { taxRatePercent: p.tax_rate_percent, taxBehavior: 'inclusive' }),
    item_type: p.product_type,
  };
  return { simulation, line };
}

/** The purchases an initial charge owes: the linked ones not yet paid. */
export async function chargeableSetPurchases(exec: Conn, gymId: string, productSetId: number): Promise<SetPurchase[]> {
  return (await loadSetPurchases(exec, gymId, productSetId))
    .filter((p) => p.status === 'draft' || p.status === 'pending_payment');
}
