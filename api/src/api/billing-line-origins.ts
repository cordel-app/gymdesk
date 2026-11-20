/**
 * #3122 stage 1 — the one writer of `billing_event_lines`, and the one place a line's contractual
 * origin is named. A Membership Fee line points at the Product Set's plan snapshot, a Product line at
 * the Product Set's recurring Product snapshot for that Product — each only when the Product Set holds
 * exactly one such snapshot, so a line is never attributed by guesswork (the pointer stays NULL
 * otherwise, as it does for purchases and adjustments). The figures themselves stay the line's own.
 */
import type { Tx } from '../infra/db';
import type { BillingEventLineRow } from '../domain/billingEventLines';

/** Pure: picks the origin of one line from the candidates the Product Set holds. */
export function pickLineOrigin(
  line: Pick<BillingEventLineRow, 'kind' | 'product_id'>,
  planSnapshotIds: readonly number[],
  periodicalByProduct: ReadonlyMap<number, readonly number[]>,
): { plan_snapshot_id: number | null; product_periodical_snapshot_id: number | null } {
  let plan: number | null = null;
  let periodical: number | null = null;
  if (line.kind === 'membership_fee') {
    plan = planSnapshotIds.length === 1 ? planSnapshotIds[0] : null;
  } else if (line.kind === 'product' && line.product_id != null) {
    const ids = periodicalByProduct.get(line.product_id) ?? [];
    periodical = ids.length === 1 ? ids[0] : null;
  }
  return { plan_snapshot_id: plan, product_periodical_snapshot_id: periodical };
}

export async function writeEventLines(
  tx: Tx, gymId: string, eventId: number, productSetId: number | null, lines: readonly BillingEventLineRow[],
): Promise<void> {
  let planIds: number[] = [];
  const byProduct = new Map<number, number[]>();
  if (productSetId != null && lines.length > 0) {
    const { rows: plans } = await tx.query<{ plan_snapshot_id: number }>(
      `SELECT plan_snapshot_id FROM product_set_plan_snapshots WHERE product_set_id = ?`, [productSetId]);
    planIds = plans.map((r) => Number(r.plan_snapshot_id));
    const { rows: periodicals } = await tx.query<{ id: number; product_id: number }>(
      `SELECT s.id, s.product_id FROM product_set_periodical_snapshots j
         JOIN product_periodical_snapshots s ON s.id = j.product_periodical_snapshot_id
        WHERE j.product_set_id = ?`, [productSetId]);
    for (const r of periodicals) {
      const list = byProduct.get(Number(r.product_id)) ?? [];
      list.push(Number(r.id));
      byProduct.set(Number(r.product_id), list);
    }
  }
  for (const l of lines) {
    const origin = pickLineOrigin(l, planIds, byProduct);
    await tx.query(
      `INSERT INTO billing_event_lines
         (gym_id, billing_event_id, kind, product_id, item_name, item_type, quantity, regular_unit_price,
          treatment_action, treatment_value, promotion_name, prorated_days, period_days,
          tax_rate_percent, tax_behavior, amount_excl_tax, amount, plan_snapshot_id, product_periodical_snapshot_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [gymId, eventId, l.kind, l.product_id, l.item_name, l.item_type, l.quantity, l.regular_unit_price,
        l.treatment_action, l.treatment_value, l.promotion_name, l.prorated_days, l.period_days,
        l.tax_rate_percent, l.tax_behavior, l.amount_excl_tax, l.amount,
        origin.plan_snapshot_id, origin.product_periodical_snapshot_id],
    );
  }
}
