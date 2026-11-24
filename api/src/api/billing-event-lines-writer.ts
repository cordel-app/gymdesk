/**
 * The one writer of `billing_event_lines`: a line restates the engine's figures (#1325 stage 2a) and
 * nothing else. #3122 stage 1's snapshot attribution was reverted (migration 463), so a line carries
 * no reference to the contractual snapshot behind it. #3254: it does carry its `source` (`plan` | `product`),
 * the classification the engine's builder gave it. #3284: and every treatment that explains its amount,
 * one `billing_event_line_reasons` row each, in the order the engine applied them (`lineReasons()`).
 */
import type { Tx } from '../infra/db';
import type { BillingEventLineRow } from '../domain/billingEventLines';

export async function writeEventLines(
  tx: Tx, gymId: string, eventId: number, lines: readonly BillingEventLineRow[],
): Promise<void> {
  for (const l of lines) {
    const { insertId } = await tx.query(
      `INSERT INTO billing_event_lines
         (gym_id, billing_event_id, kind, source, product_id, item_name, item_type, quantity, regular_unit_price,
          treatment_action, treatment_value, promotion_name, prorated_days, period_days,
          tax_rate_percent, tax_behavior, amount_excl_tax, amount, line_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [gymId, eventId, l.kind, l.source, l.product_id, l.item_name, l.item_type, l.quantity, l.regular_unit_price,
        l.treatment_action, l.treatment_value, l.promotion_name, l.prorated_days, l.period_days,
        l.tax_rate_percent, l.tax_behavior, l.amount_excl_tax, l.amount, l.line_key ?? null],
    );
    const reasons = l.reasons ?? [];
    for (let i = 0; i < reasons.length; i++) {
      const r = reasons[i];
      await tx.query(
        `INSERT INTO billing_event_line_reasons
           (gym_id, billing_event_line_id, position, reason_type, source, reason_code, action, value, name)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [gymId, Number(insertId), i + 1, r.type, r.source, r.code, r.action, r.value, r.name],
      );
    }
  }
}
