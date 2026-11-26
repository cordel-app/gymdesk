// #3311 — the I/O half of the Member card's Payments History and Forecast
// (`domain/paymentsTimeline.ts` decides). It reads the member's ledger and the
// Active Product Set's projected obligations, and writes nothing.
//
// #3446 — the projection is `planScheduledEvents()` (the obligations the
// rolling window persists from, one per schedule and date) run twice: once with
// the engine's own per-stream horizon (two complete cycles of each schedule) to
// find the common horizon — two cycles of the longest cadence — and once with
// every stream run to it, so a 4-weekly line keeps its cycles across a yearly
// line's two years.

import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext } from '../infra/tenantContext';
import {
  buildPaymentsTimeline, commonForecastHorizon,
  type TimelineEventInput, type TimelineForecastObligation, type TimelineLine,
} from '../domain/paymentsTimeline';
import { activeProductSetIdForMember } from './product-set-bridge';
import { planScheduledEvents, plannedEventAmount, type PlannedEvent } from './product-set-configuration';
import { nameSimulatedEvents } from './billing-event-name';

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function loadPaymentsTimeline(gymId: string, memberId: number, today = todayUtc()) {
  const { rows } = await db.query<any>(
    `SELECT be.id, be.event_type, be.amount, be.name, be.billing_date, be.created_at,
            be.is_scheduled, sch.schedule_key, be.period_start, be.cancelled_at,
            (SELECT pr.status FROM payment_requests pr
              WHERE pr.billing_event_id = be.id
              ORDER BY pr.created_at DESC, pr.id DESC LIMIT 1) AS latest_tx_status,
            (SELECT pr.completed_at FROM payment_requests pr
              WHERE pr.billing_event_id = be.id AND pr.transaction_type = 'payment' AND pr.status = 'completed'
              ORDER BY pr.completed_at DESC, pr.id DESC LIMIT 1) AS paid_at
       FROM billing_events be
       LEFT JOIN product_set_schedules sch ON sch.id = be.schedule_id
      WHERE be.gym_id = ? AND be.member_id = ?
      ORDER BY be.id`,
    [gymId, memberId],
  );
  const ids = rows.map((r: any) => Number(r.id));
  const linesByEvent = new Map<number, TimelineLine[]>();
  const productsByEvent = new Map<number, number[]>();
  const lineObligationsByEvent = new Map<number, { schedule_key: string; period_start: Date | string }[]>();
  if (ids.length > 0) {
    const { rows: lineRows } = await db.query<any>(
      `SELECT bl.billing_event_id, bl.item_name, bl.quantity, bl.amount, bl.product_id,
              lsch.schedule_key AS line_schedule_key, bl.period_start AS line_period_start
         FROM billing_event_lines bl
         LEFT JOIN product_set_schedules lsch ON lsch.id = bl.schedule_id
        WHERE bl.gym_id = ? AND bl.billing_event_id IN (${ids.map(() => '?').join(',')})
        ORDER BY bl.billing_event_id, bl.id`,
      [gymId, ...ids],
    );
    for (const l of lineRows) {
      const key = Number(l.billing_event_id);
      const list = linesByEvent.get(key) ?? [];
      list.push({ label: l.item_name, quantity: Number(l.quantity), amount: Number(l.amount) });
      linesByEvent.set(key, list);
      if (l.product_id != null) productsByEvent.set(key, [...(productsByEvent.get(key) ?? []), Number(l.product_id)]);
      if (l.line_schedule_key != null && l.line_period_start != null) {
        lineObligationsByEvent.set(key, [...(lineObligationsByEvent.get(key) ?? []),
          { schedule_key: String(l.line_schedule_key), period_start: l.line_period_start }]);
      }
    }
  }
  const events: TimelineEventInput[] = rows.map((r: any) => ({
    id: Number(r.id),
    event_type: r.event_type,
    amount: Number(r.amount ?? 0),
    name: r.name ?? null,
    billing_date: r.billing_date,
    created_at: r.created_at,
    is_scheduled: Number(r.is_scheduled) === 1,
    schedule_key: r.schedule_key ?? null,
    period_start: r.period_start ?? null,
    product_ids: productsByEvent.get(Number(r.id)) ?? [],
    line_obligations: lineObligationsByEvent.get(Number(r.id)) ?? [],
    cancelled: r.cancelled_at != null,
    latest_tx_status: r.latest_tx_status ?? null,
    paid_at: r.paid_at ?? null,
    lines: linesByEvent.get(Number(r.id)) ?? [],
  }));

  const setId = await activeProductSetIdForMember(db, gymId, memberId);
  const forecast = setId != null ? await loadForecastObligations(gymId, setId, today) : [];
  return buildPaymentsTimeline({ today, events, forecast });
}

/** #3446 — every projected obligation of the set from today to the common horizon. */
async function loadForecastObligations(gymId: string, setId: number, today: string): Promise<TimelineForecastObligation[]> {
  const all = Number.POSITIVE_INFINITY;
  const perStream = await planScheduledEvents(gymId, setId, today, all);
  const horizon = commonForecastHorizon(perStream.map((e) => ({ schedule_key: e.scheduleKey, date: e.date })));
  const planned = horizon == null ? perStream
    : await planScheduledEvents(gymId, setId, today, all, db, { horizonUntil: horizon });
  const obligations = planned.filter((e) => horizon == null || e.date <= horizon).map(toObligation);
  // Named per schedule, as the real events of that schedule would be (#3045).
  const bySchedule = new Map<string, TimelineForecastObligation[]>();
  for (const o of obligations) {
    const key = o.schedule_key ?? '~';
    bySchedule.set(key, [...(bySchedule.get(key) ?? []), o]);
  }
  for (const group of bySchedule.values()) await nameSimulatedEvents(db, gymId, { dates: group });
  return obligations;
}

function toObligation(e: PlannedEvent): TimelineForecastObligation {
  return {
    schedule_key: e.scheduleKey,
    date: e.date,
    total: plannedEventAmount(e),
    lines: e.lines.map((l) => ({
      label: l.label, quantity: l.quantity, actual_charge: l.actual_charge, kind: l.kind, product_id: l.product_id,
    })),
  };
}

/** Mounted under `/payments` (PAYMENTS module, `payments.transactions`). */
export const paymentsTimelineRouter = Router();

paymentsTimelineRouter.get('/members/:memberId/timeline', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const memberId = Number(req.params.memberId);
  if (!Number.isInteger(memberId) || memberId <= 0) return res.status(400).json({ error: 'invalid member id' });
  try {
    const { rows } = await db.query<any>('SELECT id FROM members WHERE id = ? AND gym_id = ?', [memberId, gymId]);
    if (rows.length === 0) return res.status(404).json({ error: 'Member not found' });
    res.json(await loadPaymentsTimeline(gymId, memberId));
  } catch (err) { next(err); }
});
