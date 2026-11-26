/**
 * #3445 — keeps the rolling window of future Billing Events of every Active Product Set full.
 *
 * Each Active set should hold its next `MAX_COVERED_CYCLES` distinct positive billing dates,
 * across all its schedules (stage 2: the window is the set's, not each schedule's), as persisted
 * Scheduled Billing Events, the obligations of several schedules on one date consolidated into one. Activation (`activateWithEvents()`) fills the
 * window on payment confirmation; this pass replenishes it as cycles stop being future, and
 * recovers a set whose activation-time generation was cut short. It is the same writer
 * (`materialiseScheduledEvents()`), so nothing here prices, charges or creates a payment attempt,
 * and an event that already exists for its `(schedule, period)` is never touched.
 *
 * #3444: each set's outcome is reported (`product_sets`): at target, replenished, a legitimate
 * shortfall (the contract owes fewer future obligations) or incomplete (fewer persisted than the
 * window planned, which fails the run like an error does) — `windowTargetStatus()` decides it.
 *
 * Each set is handled in its own transaction, under its row lock, so a concurrent activation or a
 * second pass serialises on the set; `UNIQUE (schedule_id, period_start)` is the backstop. A set
 * that fails is counted and does not stop the others.
 */

import { db, type Tx } from '../infra/db';
import { MAX_COVERED_CYCLES, materialiseScheduledEvents } from './product-set-configuration';
import { scheduleOwnerOfSetSql } from '../domain/scheduleOwner';
import { windowTargetStatus, type WindowTargetStatus } from '../domain/billingWindowStatus';

/** #3444 — one Product Set's outcome, so the run is auditable per set. */
export interface ProductSetWindowReport {
  product_set_id: number;
  gym_id: string;
  status: WindowTargetStatus | 'failed';
  /** Planned window dates that hold a Billing Event after the pass. */
  future_events: number;
  /** Distinct future positive dates the window planned (the contract's own obligations). */
  planned_events: number;
  events_created: number;
  /** Why the set holds fewer than the target, when it does. */
  reason?: 'fewer_future_obligations' | 'window_not_persisted' | 'error';
}

export interface WindowMaintenanceResult {
  product_sets_examined: number;
  product_sets_updated: number;
  events_created: number;
  /** #3445 stage 2 — obligations (schedule × date) examined across the window. */
  obligations_examined: number;
  /** Obligations folded into another schedule's event on the same date. */
  lines_consolidated: number;
  /** Zero-value obligations not persisted. */
  zero_value_skipped: number;
  /** Obligations already persisted or paid by an initial payment. */
  already_covered: number;
  failures: number;
  /** #3444 — the target each set is held to: distinct future positive dates. */
  target_events: number;
  /** Sets that already held the target before the pass. */
  product_sets_at_target: number;
  /** Sets that hold fewer because their contract owes fewer future obligations (legitimate). */
  product_sets_shortfall: number;
  /** Sets that hold fewer than the window planned: the run is operationally incomplete. */
  product_sets_incomplete: number;
  product_sets: ProductSetWindowReport[];
}

/**
 * How many of the window's planned dates hold a Billing Event of the set: a Scheduled event of one
 * of the owner's schedules, or the set's own payment that already covered the date (the initial
 * payment, #1521). Read back from the ledger after the pass, independently of what the pass reports
 * having written; like the writer's own idempotency check, any event on the date counts (a
 * cancelled or attempted one is the record of that obligation and is never written again).
 */
async function coveredWindowDates(tx: Tx, gymId: string, productSetId: number, dates: string[]): Promise<number> {
  if (dates.length === 0) return 0;
  const { rows } = await tx.query<{ n: number }>(
    `SELECT COUNT(DISTINCT be.billing_date) AS n FROM billing_events be
      WHERE be.gym_id = ?
        AND be.billing_date IN (${dates.map(() => '?').join(',')})
        AND (be.product_set_id = ?
             OR be.schedule_id IN (SELECT id FROM product_set_schedules WHERE ${scheduleOwnerOfSetSql()}))`,
    [gymId, ...dates, productSetId, productSetId]);
  return Number(rows[0]?.n ?? 0);
}

export async function maintainBillingWindow(
  today: string,
  log?: { error: (obj: object, msg: string) => void },
): Promise<WindowMaintenanceResult> {
  const { rows } = await db.query<{ id: number; gym_id: string }>(
    `SELECT id, gym_id FROM product_sets WHERE status = 'active' ORDER BY id`,
  );
  const result: WindowMaintenanceResult = {
    product_sets_examined: 0, product_sets_updated: 0, events_created: 0,
    obligations_examined: 0, lines_consolidated: 0, zero_value_skipped: 0, already_covered: 0, failures: 0,
    target_events: MAX_COVERED_CYCLES, product_sets_at_target: 0, product_sets_shortfall: 0,
    product_sets_incomplete: 0, product_sets: [],
  };
  for (const row of rows) {
    result.product_sets_examined += 1;
    try {
      const out = await db.transaction(async (tx) => {
        const { rows: locked } = await tx.query<{ status: string }>(
          'SELECT status FROM product_sets WHERE id = ? AND gym_id = ? FOR UPDATE', [row.id, row.gym_id]);
        // Superseded or cancelled since the list was read: its successor holds the window.
        if (locked[0]?.status !== 'active') return null;
        const materialised = await materialiseScheduledEvents(tx, {
          gymId: String(row.gym_id), productSetId: Number(row.id), today,
        });
        const persisted = await coveredWindowDates(tx, String(row.gym_id), Number(row.id), materialised.window_dates);
        return { ...materialised, persisted };
      });
      if (out) {
        result.events_created += out.created;
        result.obligations_examined += out.obligations_examined;
        result.lines_consolidated += out.lines_consolidated;
        result.zero_value_skipped += out.zero_value_skipped;
        result.already_covered += out.already_covered;
        if (out.created > 0) result.product_sets_updated += 1;
        const status = windowTargetStatus({
          target: MAX_COVERED_CYCLES, persistedDates: out.persisted,
          plannedDates: out.window_dates.length, created: out.created,
        });
        if (status === 'at_target') result.product_sets_at_target += 1;
        if (status === 'shortfall') result.product_sets_shortfall += 1;
        if (status === 'incomplete') {
          result.product_sets_incomplete += 1;
          log?.error({ productSetId: row.id, persisted: out.persisted, planned: out.window_dates.length },
            'billing window maintenance: set left below its planned window');
        }
        result.product_sets.push({
          product_set_id: Number(row.id), gym_id: String(row.gym_id), status,
          future_events: out.persisted, planned_events: out.window_dates.length, events_created: out.created,
          ...(status === 'shortfall' ? { reason: 'fewer_future_obligations' as const } : {}),
          ...(status === 'incomplete' ? { reason: 'window_not_persisted' as const } : {}),
        });
      }
    } catch (err) {
      result.failures += 1;
      result.product_sets.push({
        product_set_id: Number(row.id), gym_id: String(row.gym_id), status: 'failed',
        future_events: 0, planned_events: 0, events_created: 0, reason: 'error',
      });
      log?.error({ err: (err as Error).message, productSetId: row.id }, 'billing window maintenance: set failed');
    }
  }
  return result;
}
