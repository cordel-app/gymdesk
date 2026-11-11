import type { Tx } from '../infra/db';
import { calendarAnchorOnOrBefore, calendarGridOf } from '../domain/calendarSchedule';
import { classifyMergedEvent, consolidationGroups, type ConsolidationEvent } from '../domain/scheduleConsolidation';
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
 * #2125 M5c-2 — then the chain's schedules that are one schedule (the same
 * cadence on one billing calendar, `domain/scheduleConsolidation.ts`) are
 * consolidated into one (`consolidateChainSchedules()`), before the generator
 * runs, so the regenerated obligations land on the one schedule left.
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
  /** #2125 M5c-3: the run is per owner; the root is the one asked about (or the owner's lowest). */
  rootProductSetId: number;
  ownerMemberId: number;
  activeProductSetId: number | null;
  schedules: ScheduleRealignment[];
  createdEvents: number;
  consolidations: ScheduleConsolidation[];
}

export interface ScheduleConsolidation {
  targetScheduleId: number;
  mergedScheduleId: number;
  /** Events moved onto the target unchanged. */
  repointedEvents: number;
  /** Untouched future obligations that collided with the target's for the same period: deleted, regenerated. */
  regeneratedEvents: number;
  /** Events that collided and could not be merged (past, attempted or paid): left on the merged schedule. */
  keptEvents: number[];
  /** Whether the merged schedule was deleted (nothing references it any more). */
  removed: boolean;
}

/** Every table whose rows name the schedule they bill on (FK `ON DELETE SET NULL`). */
const SCHEDULED_SNAPSHOT_TABLES = [
  'plan_snapshots', 'plan_periodical_snapshots', 'member_products_recurrent_snapshot', 'product_periodical_snapshots',
] as const;

const toDateOnly = (v: unknown): string =>
  v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);

export async function realignChainSchedules(tx: Tx, input: {
  gymId: string; rootProductSetId: number; today: string;
}): Promise<ChainRealignment> {
  const { rows } = await tx.query<{ owner_member_id: number }>(
    'SELECT owner_member_id FROM product_sets WHERE id = ? AND gym_id = ?', [input.rootProductSetId, input.gymId]);
  if (!rows[0]) throw new Error('ProductSet not found');
  return realignOwnerSchedules(tx, {
    gymId: input.gymId, ownerMemberId: Number(rows[0].owner_member_id), today: input.today,
    rootProductSetId: input.rootProductSetId,
  });
}

/**
 * #2125 M5c-3 — the realignment and the consolidation run over **every**
 * schedule of the owner (`(owner, periodicity)`), so schedules of one identity
 * that two of the owner's chains opened are folded into one exactly as two of
 * one chain's are. The owner's Active version (at most one) is regenerated.
 */
export async function realignOwnerSchedules(tx: Tx, input: {
  gymId: string; ownerMemberId: number; today: string; rootProductSetId?: number;
}): Promise<ChainRealignment> {
  const { gymId, ownerMemberId, today } = input;
  const { rows: active } = await tx.query<{ id: number; root_product_set_id: number }>(
    `SELECT id, root_product_set_id FROM product_sets
      WHERE gym_id = ? AND owner_member_id = ? AND status = 'active' FOR UPDATE`,
    [gymId, ownerMemberId]);
  const { rows: schedules } = await tx.query<any>(
    `SELECT id, root_product_set_id, anchor_date, cadence_interval, cadence_unit FROM product_set_schedules
      WHERE gym_id = ? AND owner_member_id = ? ORDER BY id FOR UPDATE`,
    [gymId, ownerMemberId]);
  const rootProductSetId = input.rootProductSetId
    ?? (active[0] ? Number(active[0].root_product_set_id) : Number(schedules[0]?.root_product_set_id ?? 0));

  const out: ChainRealignment = {
    gymId, rootProductSetId, ownerMemberId,
    activeProductSetId: active[0] ? Number(active[0].id) : null,
    schedules: [], createdEvents: 0, consolidations: [],
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

  out.consolidations = await consolidateOwnerSchedules(tx, { gymId, ownerMemberId, today });

  if ((out.schedules.length > 0 || out.consolidations.length > 0) && out.activeProductSetId != null) {
    const { created } = await materialiseScheduledEvents(tx, {
      gymId, productSetId: out.activeProductSetId, today,
    });
    out.createdEvents = created;
  }
  return out;
}

/**
 * #2125 M5c-2 — folds the chain's schedules that are one schedule into one
 * (`consolidationGroups()`), each event handled by `classifyMergedEvent()`.
 * Every snapshot line billing on a merged schedule moves to the target (a
 * re-pointing that changes no configuration: the two bill on the same dates),
 * the target takes the earliest anchor of its group (still a date of its grid,
 * so a line that started before the target's own anchor keeps its alignment),
 * and a merged schedule is deleted once no event references it. The caller
 * regenerates the obligations (`materialiseScheduledEvents()`). Idempotent: a
 * second run finds no group, or only a schedule kept for its history, which it
 * leaves as it is.
 */
export async function consolidateChainSchedules(tx: Tx, input: {
  gymId: string; rootProductSetId: number; today: string;
}): Promise<ScheduleConsolidation[]> {
  const { rows } = await tx.query<{ owner_member_id: number }>(
    'SELECT owner_member_id FROM product_sets WHERE id = ? AND gym_id = ?', [input.rootProductSetId, input.gymId]);
  if (!rows[0]) return [];
  return consolidateOwnerSchedules(tx, {
    gymId: input.gymId, ownerMemberId: Number(rows[0].owner_member_id), today: input.today });
}

/** #2125 M5c-3 — the consolidation over every schedule of the owner, across their chains. */
export async function consolidateOwnerSchedules(tx: Tx, input: {
  gymId: string; ownerMemberId: number; today: string;
}): Promise<ScheduleConsolidation[]> {
  const { gymId, ownerMemberId, today } = input;
  const { rows: schedules } = await tx.query<any>(
    `SELECT id, schedule_key, anchor_date, cadence_interval, cadence_unit FROM product_set_schedules
      WHERE gym_id = ? AND owner_member_id = ? ORDER BY id FOR UPDATE`,
    [gymId, ownerMemberId]);
  const groups = consolidationGroups(schedules.map((s: any) => ({
    id: Number(s.id), key: String(s.schedule_key), anchorDate: toDateOnly(s.anchor_date),
    cadence: { interval: Number(s.cadence_interval), unit: String(s.cadence_unit) },
  })));
  const anchorOf = new Map<number, string>(schedules.map((s: any) => [Number(s.id), toDateOnly(s.anchor_date)]));

  const loadEvents = async (scheduleId: number) => {
    const { rows } = await tx.query<any>(
      `SELECT be.id, be.period_start, be.billing_date, be.is_scheduled,
              EXISTS (SELECT 1 FROM payment_requests pr WHERE pr.billing_event_id = be.id) AS attempted
         FROM billing_events be WHERE be.gym_id = ? AND be.schedule_id = ? ORDER BY be.id FOR UPDATE`,
      [gymId, scheduleId]);
    return rows.map((r: any) => ({
      id: Number(r.id),
      event: {
        periodStart: r.period_start != null ? toDateOnly(r.period_start) : null,
        billingDate: r.billing_date != null ? toDateOnly(r.billing_date) : null,
        isScheduled: Number(r.is_scheduled) === 1,
        attempted: Number(r.attempted) === 1,
      } as ConsolidationEvent,
    }));
  };

  const out: ScheduleConsolidation[] = [];
  for (const group of groups) {
    const target = group.targetId;
    const earliest = [target, ...group.mergedIds].map((id) => anchorOf.get(id)!).sort()[0];
    if (earliest !== anchorOf.get(target)) {
      await tx.query('UPDATE product_set_schedules SET anchor_date = ? WHERE id = ?', [earliest, target]);
    }
    const targetByPeriod = new Map<string, { id: number; event: ConsolidationEvent }>();
    for (const e of await loadEvents(target)) {
      if (e.event.periodStart != null) targetByPeriod.set(e.event.periodStart, e);
    }

    for (const merged of group.mergedIds) {
      for (const table of SCHEDULED_SNAPSHOT_TABLES) {
        await tx.query(`UPDATE ${table} SET schedule_id = ? WHERE gym_id = ? AND schedule_id = ?`, [target, gymId, merged]);
      }
      const result: ScheduleConsolidation = {
        targetScheduleId: target, mergedScheduleId: merged,
        repointedEvents: 0, regeneratedEvents: 0, keptEvents: [], removed: false,
      };
      for (const e of await loadEvents(merged)) {
        const collision = e.event.periodStart != null ? targetByPeriod.get(e.event.periodStart) ?? null : null;
        const action = classifyMergedEvent(e.event, collision?.event ?? null, today);
        if (action === 'repoint') {
          await tx.query('UPDATE billing_events SET schedule_id = ? WHERE id = ?', [target, e.id]);
          if (e.event.periodStart != null) targetByPeriod.set(e.event.periodStart, e);
          result.repointedEvents += 1;
        } else if (action === 'regenerate') {
          await tx.query('DELETE FROM billing_events WHERE id IN (?, ?)', [e.id, collision!.id]);
          targetByPeriod.delete(e.event.periodStart!);
          result.regeneratedEvents += 1;
        } else {
          result.keptEvents.push(e.id);
        }
      }
      if (result.keptEvents.length === 0) {
        await tx.query('DELETE FROM product_set_schedules WHERE id = ? AND gym_id = ?', [merged, gymId]);
        result.removed = true;
      }
      out.push(result);
    }
  }
  return out;
}
