// #3311 — the I/O half of the Member card's Payments History and Forecast
// (`domain/paymentsTimeline.ts` decides). It reads the member's ledger and the
// Active Product Set's forecast, and writes nothing.

import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext } from '../infra/tenantContext';
import { buildPaymentsTimeline, type TimelineEventInput, type TimelineLine } from '../domain/paymentsTimeline';
import { activeProductSetIdForMember } from './product-set-bridge';
import { productSetForecast } from './product-set-draft-router';
import { nameSimulatedEvents } from './billing-event-name';

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function loadPaymentsTimeline(gymId: string, memberId: number, today = todayUtc()) {
  const { rows } = await db.query<any>(
    `SELECT be.id, be.event_type, be.amount, be.name, be.billing_date, be.created_at,
            be.is_scheduled, (be.schedule_id IS NOT NULL) AS on_schedule, be.cancelled_at,
            (SELECT pr.status FROM payment_requests pr
              WHERE pr.billing_event_id = be.id
              ORDER BY pr.created_at DESC, pr.id DESC LIMIT 1) AS latest_tx_status,
            (SELECT pr.completed_at FROM payment_requests pr
              WHERE pr.billing_event_id = be.id AND pr.transaction_type = 'payment' AND pr.status = 'completed'
              ORDER BY pr.completed_at DESC, pr.id DESC LIMIT 1) AS paid_at
       FROM billing_events be
      WHERE be.gym_id = ? AND be.member_id = ?
      ORDER BY be.id`,
    [gymId, memberId],
  );
  const ids = rows.map((r: any) => Number(r.id));
  const linesByEvent = new Map<number, TimelineLine[]>();
  if (ids.length > 0) {
    const { rows: lineRows } = await db.query<any>(
      `SELECT billing_event_id, item_name, quantity, amount FROM billing_event_lines
        WHERE gym_id = ? AND billing_event_id IN (${ids.map(() => '?').join(',')})
        ORDER BY billing_event_id, id`,
      [gymId, ...ids],
    );
    for (const l of lineRows) {
      const key = Number(l.billing_event_id);
      const list = linesByEvent.get(key) ?? [];
      list.push({ label: l.item_name, quantity: Number(l.quantity), amount: Number(l.amount) });
      linesByEvent.set(key, list);
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
    on_schedule: Number(r.on_schedule) === 1,
    cancelled: r.cancelled_at != null,
    latest_tx_status: r.latest_tx_status ?? null,
    paid_at: r.paid_at ?? null,
    lines: linesByEvent.get(Number(r.id)) ?? [],
  }));

  const setId = await activeProductSetIdForMember(db, gymId, memberId);
  let forecast: { dates: any[] } = { dates: [] };
  if (setId != null) {
    const base = await productSetForecast(gymId, setId);
    if (base?.available) forecast = await nameSimulatedEvents(db, gymId, base);
  }
  return buildPaymentsTimeline({ today, events, forecast: forecast.dates });
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
