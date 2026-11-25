/**
 * #3307 stage 5 — the Initial Payment of a Product Set awaiting payment, as Save & Pay persisted it.
 *
 * Once a cart leaves In Cart its initial Billing Event and lines exist: the Summary of a version
 * awaiting payment states those (the figures the member is asked to pay), never a fresh re-price.
 * The lines are read back through `chargeLineView()`, the one reading of a charge line, with the
 * waiver taken from the line's own persisted `initial_payment_waive` reason and nothing waivable:
 * a version awaiting payment is not edited. Nothing is written.
 */
import { db } from '../infra/db';
import { chargeLineView } from '../domain/checkoutSummary';
import type { ChargeLineLike } from '../domain/checkoutSummary';
import { INITIAL_PAYMENT_WAIVE_CODE } from '../domain/initialPaymentWaiver';

export interface PendingInitialPayment {
  billingEventId: number;
  amount: number;
  lines: ChargeLineLike[];
}

export async function loadPendingInitialPayment(gymId: string, productSetId: number): Promise<PendingInitialPayment | null> {
  const { rows: events } = await db.query<any>(
    `SELECT be.id, be.amount FROM billing_events be
      WHERE be.gym_id = ? AND be.product_set_id = ? AND be.event_type = 'payment_recorded'
        AND be.cancelled_at IS NULL
      ORDER BY be.id DESC LIMIT 1`,
    [gymId, productSetId]);
  const ev = events[0];
  if (!ev) return null;
  const eventId = Number(ev.id);
  const { rows: lineRows } = await db.query<any>(
    `SELECT id, source, item_name, quantity, regular_unit_price, treatment_action, treatment_value, promotion_name,
            prorated_days, period_days, tax_rate_percent, amount_excl_tax, amount, line_key
       FROM billing_event_lines
      WHERE gym_id = ? AND billing_event_id = ?
      ORDER BY id`,
    [gymId, eventId]);
  const reasonsByLine = new Map<number, any[]>();
  if (lineRows.length > 0) {
    const { rows: reasonRows } = await db.query<any>(
      `SELECT billing_event_line_id, reason_type, source, reason_code, action, value, name
         FROM billing_event_line_reasons
        WHERE gym_id = ? AND billing_event_line_id IN (${lineRows.map(() => '?').join(',')})
        ORDER BY billing_event_line_id, position`,
      [gymId, ...lineRows.map((l: any) => Number(l.id))]);
    for (const r of reasonRows) {
      const key = Number(r.billing_event_line_id);
      reasonsByLine.set(key, [...(reasonsByLine.get(key) ?? []), r]);
    }
  }
  const lines = lineRows.map((l: any) => {
    const reasons = reasonsByLine.get(Number(l.id)) ?? [];
    return chargeLineView({
      ...l,
      reasons,
      waived: reasons.some((r) => r.reason_code === INITIAL_PAYMENT_WAIVE_CODE),
      waivable: false,
    });
  });
  return { billingEventId: eventId, amount: Math.round(Number(ev.amount) * 100) / 100, lines };
}
