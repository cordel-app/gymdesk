import type { Tx } from '../infra/db';
import { calendarAnchorOnOrBefore, calendarGridOf } from '../domain/calendarSchedule';
import { materialiseScheduledEvents } from './product-set-configuration';

/**
 * #2125 M5c (Oscar, 2026-11-11, Option B) — moves a chain's existing schedules
 * onto the billing calendar (`domain/calendarSchedule.ts`) and regenerates the
 * obligations that move with them. The one writer of a re-anchor; run by
 * `npm run schedules:realign` (`scripts/realign-billing-schedules.ts`), never by
 * a migration, because regenerating an obligation needs the engine.
 *
 * Per schedule whose anchor is not its cadence's grid date (a yearly schedule
 * keeps its anniversary and is never touched):
 *
 *   1. its future obligations (`is_scheduled`, due **after** `today`) that have
 *      **no** `payment_requests` row of any kind are deleted — the
 *      `replaceFutureScheduledEvents()` rule, lines going with them by the FK;
 *   2. a future obligation that **has** an attempt is kept as it is and reported
 *      (`keptAttempted`): its payment history is never rewritten;
 *   3. the anchor moves to the grid date on or before the old one.
 *
 * Then the chain's Active version, if any, is materialised again from `today`
 * by the existing generator, so the new dates come from the engine and an
 * obligation that already exists for the same `(schedule, period)` is not
 * created twice. Nothing is prorated or compensated for the transition, and
 * past events, attempts, receipts and every `payment_requests` row are left
 * exactly as they are.
 *
 * Consolidating two schedules of one cadence in a chain into one is not done
 * here (it is the `(owner, periodicity)` re-keying); such chains are reported
 * (`sameCadenceSchedules`).
 */
export interface ScheduleRealignment {
  scheduleId: number;
  cadence: string;
  from: string;
  to: string;
  deletedEvents: number;
  keptAttempted: number[];
}

export interface ChainRealignment {
  gymId: string;
  rootProductSetId: number;
  activeProductSetId: number | null;
  schedules: ScheduleRealignment[];
  createdEvents: number;
  sameCadenceSchedules: boolean;
}

const toDateOnly = (v: unknown): string =>
  v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);

export async function realignChainSchedules(tx: Tx, input: {
  gymId: string; rootProductSetId: number; today: string;
}): Promise<ChainRealignment> {
  const { gymId, rootProductSetId, today } = input;
  const { rows: active } = await tx.query<{ id: number }>(
    `SELECT id FROM product_sets
      WHERE gym_id = ? AND root_product_set_id = ? AND status = 'active' FOR UPDATE`,
    [gymId, rootProductSetId]);
  const { rows: schedules } = await tx.query<any>(
    `SELECT id, anchor_date, cadence_interval, cadence_unit FROM product_set_schedules
      WHERE gym_id = ? AND root_product_set_id = ? ORDER BY id FOR UPDATE`,
    [gymId, rootProductSetId]);

  const cadences = schedules.map((s: any) => `${Number(s.cadence_interval)} ${s.cadence_unit}`);
  const out: ChainRealignment = {
    gymId, rootProductSetId,
    activeProductSetId: active[0] ? Number(active[0].id) : null,
    schedules: [], createdEvents: 0,
    sameCadenceSchedules: new Set(cadences).size < cadences.length,
  };

  for (const s of schedules) {
    const cadence = { interval: Number(s.cadence_interval), unit: String(s.cadence_unit) };
    if (!calendarGridOf(cadence)) continue;
    const from = toDateOnly(s.anchor_date);
    const to = calendarAnchorOnOrBefore(cadence, from);
    if (to === from) continue;

    const { rows: attempted } = await tx.query<{ id: number }>(
      `SELECT be.id FROM billing_events be
        WHERE be.gym_id = ? AND be.schedule_id = ? AND be.is_scheduled = 1 AND be.billing_date > ?
          AND EXISTS (SELECT 1 FROM payment_requests pr WHERE pr.billing_event_id = be.id)
        ORDER BY be.id`,
      [gymId, s.id, today]);
    const { rowCount } = await tx.query(
      `DELETE FROM billing_events
        WHERE gym_id = ? AND schedule_id = ? AND is_scheduled = 1 AND billing_date > ?
          AND NOT EXISTS (SELECT 1 FROM payment_requests pr WHERE pr.billing_event_id = billing_events.id)`,
      [gymId, s.id, today]);
    await tx.query('UPDATE product_set_schedules SET anchor_date = ? WHERE id = ?', [to, s.id]);
    out.schedules.push({
      scheduleId: Number(s.id), cadence: `${cadence.interval} ${cadence.unit}`, from, to,
      deletedEvents: rowCount, keptAttempted: attempted.map((r) => Number(r.id)),
    });
  }

  if (out.schedules.length > 0 && out.activeProductSetId != null) {
    const { created } = await materialiseScheduledEvents(tx, {
      gymId, productSetId: out.activeProductSetId, today,
    });
    out.createdEvents = created;
  }
  return out;
}
