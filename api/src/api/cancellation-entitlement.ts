import type { Tx } from '../infra/db';
import { BillingDateUnit } from '../domain/billingDate';
import { PLAN_SCHEDULE_KEY } from '../domain/scheduleAllocation';
import { PaidPeriod, ScheduleCadence, paidThroughDate } from '../domain/cancellationEntitlement';

/**
 * #1196 — the SQL half of the cancellation entitlement: the paid periods of a
 * ProductSet chain's plan schedule. An event counts only when money actually
 * settled it (a completed provider or cash attempt, never a waiver), and only
 * the plan's own schedule counts — a Product's schedule says nothing about the
 * membership. Read from the chain, so a superseded version's paid period is
 * still the contract's.
 */
export async function loadPaidThrough(tx: Tx, gymId: string, rootProductSetId: number): Promise<string | null> {
  const { rows: sch } = await tx.query<any>(
    `SELECT id, cadence_interval, cadence_unit FROM product_set_schedules
      WHERE root_product_set_id = ? AND schedule_key = ?`, [rootProductSetId, PLAN_SCHEDULE_KEY]);
  if (!sch[0]) return null;
  const cadence: ScheduleCadence | null = sch[0].cadence_interval && sch[0].cadence_unit
    ? { interval: Number(sch[0].cadence_interval), unit: String(sch[0].cadence_unit) as BillingDateUnit }
    : null;

  const { rows: events } = await tx.query<any>(
    `SELECT be.id, be.period_start, be.period_end
       FROM billing_events be
      WHERE be.gym_id = ? AND be.schedule_id = ? AND be.period_start IS NOT NULL
        AND EXISTS (SELECT 1 FROM payment_requests pr
                     WHERE pr.billing_event_id = be.id AND pr.gym_id = be.gym_id
                       AND pr.status = 'completed' AND pr.method <> 'waive')`,
    [gymId, Number(sch[0].id)]);
  const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10);
  const periods: PaidPeriod[] = events.map((e: any) => ({
    periodStart: iso(e.period_start), periodEnd: e.period_end ? iso(e.period_end) : null,
  }));
  return paidThroughDate(periods, cadence);
}
