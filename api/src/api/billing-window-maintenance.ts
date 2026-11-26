/**
 * #3445 — keeps the rolling window of future Billing Events of every Active Product Set full.
 *
 * Each recurring schedule of an Active set should hold its next `MAX_COVERED_CYCLES` positive
 * obligations as persisted Scheduled Billing Events. Activation (`activateWithEvents()`) fills the
 * window on payment confirmation; this pass replenishes it as cycles stop being future, and
 * recovers a set whose activation-time generation was cut short. It is the same writer
 * (`materialiseScheduledEvents()`), so nothing here prices, charges or creates a payment attempt,
 * and an event that already exists for its `(schedule, period)` is never touched.
 *
 * Each set is handled in its own transaction, under its row lock, so a concurrent activation or a
 * second pass serialises on the set; `UNIQUE (schedule_id, period_start)` is the backstop. A set
 * that fails is counted and does not stop the others.
 */

import { db } from '../infra/db';
import { materialiseScheduledEvents } from './product-set-configuration';

export interface WindowMaintenanceResult {
  product_sets_examined: number;
  product_sets_updated: number;
  events_created: number;
  failures: number;
}

export async function maintainBillingWindow(
  today: string,
  log?: { error: (obj: object, msg: string) => void },
): Promise<WindowMaintenanceResult> {
  const { rows } = await db.query<{ id: number; gym_id: string }>(
    `SELECT id, gym_id FROM product_sets WHERE status = 'active' ORDER BY id`,
  );
  const result: WindowMaintenanceResult = {
    product_sets_examined: 0, product_sets_updated: 0, events_created: 0, failures: 0,
  };
  for (const row of rows) {
    result.product_sets_examined += 1;
    try {
      const created = await db.transaction(async (tx) => {
        const { rows: locked } = await tx.query<{ status: string }>(
          'SELECT status FROM product_sets WHERE id = ? AND gym_id = ? FOR UPDATE', [row.id, row.gym_id]);
        // Superseded or cancelled since the list was read: its successor holds the window.
        if (locked[0]?.status !== 'active') return 0;
        return (await materialiseScheduledEvents(tx, {
          gymId: String(row.gym_id), productSetId: Number(row.id), today,
        })).created;
      });
      result.events_created += created;
      if (created > 0) result.product_sets_updated += 1;
    } catch (err) {
      result.failures += 1;
      log?.error({ err: (err as Error).message, productSetId: row.id }, 'billing window maintenance: set failed');
    }
  }
  return result;
}
