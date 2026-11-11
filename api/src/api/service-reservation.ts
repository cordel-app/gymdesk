import { Tx, db } from '../infra/db';
import { spendSessionForBooking } from './service-consumption';
import { loadRequiredServices } from './activity-eligibility';
import { loadMemberProfessionalServiceGrants, resolveMemberProfessionalServices } from '../domain/memberProfessionalServices';
import { chooseSpendGrant } from '../domain/serviceConsumption';
import { availableGrants, serviceBalanceViews, ServiceBalanceView } from '../domain/serviceReservation';

/**
 * #2605 stage 1: the SQL half of the Professional Service reservation.
 * A booked row holds one unit against the grant it will later be consumed
 * from; the wallet's remaining balance is untouched, only what is available.
 */

export async function loadReservedTotals(tx: Tx, gymId: string, memberId: number) {
  const { rows } = await tx.query(
    `SELECT source_kind, source_reference_id, COUNT(*) AS reserved
       FROM professional_service_reservations
      WHERE gym_id = ? AND member_id = ? AND status = 'reserved'
      GROUP BY source_kind, source_reference_id`,
    [gymId, memberId],
  );
  return rows.map((r: any) => ({ source_kind: r.source_kind, source_reference_id: Number(r.source_reference_id), reserved: Number(r.reserved) }));
}

/** #2605 stage 3: the member's `reserved` rows counted per Professional Service. */
export async function loadBookedByService(q: Pick<Tx, 'query'>, gymId: string, memberId: number) {
  const { rows } = await q.query(
    `SELECT professional_service_id, COUNT(*) AS booked
       FROM professional_service_reservations
      WHERE gym_id = ? AND member_id = ? AND status = 'reserved'
      GROUP BY professional_service_id`,
    [gymId, memberId],
  );
  return rows.map((r: any) => ({ professional_service_id: Number(r.professional_service_id), booked: Number(r.booked) }));
}

/**
 * #2605 stage 3: total / booked / available per service, for every reader that
 * shows a balance (the staff wallet, the member's own list, the booking sheet).
 * `total` is `resolveMemberProfessionalServices()`'s balance — the booking
 * gate's own — so the three cannot disagree, and `booked` is the reservations.
 */
export async function loadServiceBalanceViews(gymId: string, memberId: number): Promise<Map<number, ServiceBalanceView>> {
  const [balances, booked] = await Promise.all([
    resolveMemberProfessionalServices(gymId, memberId),
    loadBookedByService(db, gymId, memberId),
  ]);
  return serviceBalanceViews(balances, booked);
}

/**
 * Reserve one unit for a booked row. Returns `no_available` when the member has
 * entitlement but all of it is already booked; `not_applicable` when the
 * occurrence requires no service. Serialised per member by the member row lock.
 */
export async function reserveForBooking(
  tx: Tx,
  gymId: string,
  memberId: number,
  bookingId: number,
  eventId: number,
  activityTypeId: number,
  chosenServiceId: number | null,
  actor: string | null,
): Promise<'reserved' | 'not_applicable' | 'no_available'> {
  const required = await loadRequiredServices(tx, gymId, activityTypeId, eventId);
  if (required.length === 0) return 'not_applicable';
  await tx.query('SELECT id FROM members WHERE id = ? AND gym_id = ? FOR UPDATE', [memberId, gymId]);
  const grants = availableGrants(
    await loadMemberProfessionalServiceGrants(gymId, memberId),
    await loadReservedTotals(tx, gymId, memberId),
  );
  const ids = required.map((s) => s.id);
  const grant =
    (chosenServiceId != null && ids.includes(chosenServiceId) ? chooseSpendGrant(grants, [chosenServiceId]) : null) ??
    chooseSpendGrant(grants, ids);
  if (!grant) return 'no_available';
  await tx.query(
    `INSERT IGNORE INTO professional_service_reservations
       (gym_id, member_id, calendar_event_booking_id, calendar_event_id, professional_service_id,
        source_kind, source_reference_id, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [gymId, memberId, bookingId, eventId, grant.professional_service_id, grant.kind, grant.reference_id, actor],
  );
  return 'reserved';
}

/** Release a booking's reservation, once (guarded by status). */
export async function releaseReservation(tx: Tx, gymId: string, bookingId: number): Promise<boolean> {
  const { rowCount } = await tx.query(
    "UPDATE professional_service_reservations SET status = 'released', released_at = UTC_TIMESTAMP() WHERE gym_id = ? AND calendar_event_booking_id = ? AND status = 'reserved'",
    [gymId, bookingId],
  );
  return rowCount > 0;
}

/** A spend happened for this booking: the reservation is now the consumption. */
export async function markReservationConsumed(tx: Tx, gymId: string, bookingId: number): Promise<void> {
  await tx.query(
    "UPDATE professional_service_reservations SET status = 'consumed', consumed_at = UTC_TIMESTAMP() WHERE gym_id = ? AND calendar_event_booking_id = ? AND status = 'reserved'",
    [gymId, bookingId],
  );
}

/** Release every reservation of an occurrence (event cancelled). */
export async function releaseEventReservations(tx: Tx, gymId: string, eventId: number): Promise<number> {
  const { rowCount } = await tx.query(
    "UPDATE professional_service_reservations SET status = 'released', released_at = UTC_TIMESTAMP() WHERE gym_id = ? AND calendar_event_id = ? AND status = 'reserved'",
    [gymId, eventId],
  );
  return rowCount;
}

/**
 * A booking was cancelled: if the cancel spent a session (late cancellation)
 * the reservation is the consumption, otherwise it is released. Never both.
 */
export async function settleReservationOnCancel(tx: Tx, gymId: string, bookingId: number): Promise<void> {
  const { rows } = await tx.query(
    'SELECT id FROM professional_service_consumptions WHERE gym_id = ? AND calendar_event_booking_id = ? AND returned_at IS NULL',
    [gymId, bookingId],
  );
  if (rows.length > 0) await markReservationConsumed(tx, gymId, bookingId);
  else await releaseReservation(tx, gymId, bookingId);
}

/** Cap per pass; the rest is picked up by the next one (a reservation stays `reserved`). */
export const EVENT_START_CONVERSION_MAX_PER_RUN = 500;

export interface EventStartConversion {
  candidates: number;
  consumed: number;
  released: number;
}

/**
 * #2604: at event start the reservation becomes the consumption. Walks every
 * `reserved` row of a booked booking on a scheduled occurrence that has started
 * and spends it through `spendSessionForBooking()` — the one writer, idempotent
 * per booking — then marks the reservation `consumed`. A cancelled event or an
 * in-time cancellation already released its row, so it is never a candidate;
 * a booking whose spend finds nothing to spend (no service, no balance) releases
 * its reservation so the pass cannot loop on it. A repeated pass changes nothing.
 */
export async function convertStartedReservations(): Promise<EventStartConversion> {
  const { rows } = await db.query(
    `SELECT r.gym_id, r.calendar_event_booking_id AS booking_id
       FROM professional_service_reservations r
       JOIN calendar_event_bookings ceb ON ceb.id = r.calendar_event_booking_id
       JOIN calendar_events ce ON ce.id = r.calendar_event_id
      WHERE r.status = 'reserved'
        AND ceb.status = 'booked'
        AND ce.status = 'scheduled'
        AND ce.deleted_at IS NULL
        AND ce.starts_at <= UTC_TIMESTAMP()
      ORDER BY ce.starts_at
      LIMIT ${EVENT_START_CONVERSION_MAX_PER_RUN}`,
  );
  const out: EventStartConversion = { candidates: rows.length, consumed: 0, released: 0 };
  for (const row of rows as { gym_id: string; booking_id: number }[]) {
    await db.transaction(async (tx: Tx) => {
      const res = await spendSessionForBooking(tx, row.gym_id, Number(row.booking_id), 'event_start', 'System');
      if (res.spent || res.skipped === 'already_spent') {
        await markReservationConsumed(tx, row.gym_id, Number(row.booking_id));
        if (res.spent) out.consumed++;
      } else {
        await releaseReservation(tx, row.gym_id, Number(row.booking_id));
        out.released++;
      }
    });
  }
  return out;
}

export interface ReservationBackfill {
  cutoff: string | null;
  candidates: number;
  reserved: number;
  no_available: number;
  not_applicable: number;
}

/**
 * #2605 stage 3: give the future bookings made before the reservation model a
 * reservation, once. A candidate is a `booked` row on a future, scheduled,
 * non-deleted occurrence that holds no reservation row and was booked before
 * the first reservation ever written (the moment stage 1 went live); a row
 * booked after it holds none on purpose — a staff override, an accepted
 * negative balance or a Duo partner — and is left alone, as is a partner row
 * (`booked_by_member_id` another member). Reserving goes through
 * `reserveForBooking()`, so a member whose remaining balance is already fully
 * booked gets no reservation for the rest (reported as `no_available`), and an
 * occurrence that requires no service none (`not_applicable`). Repeatable:
 * `psr_one_per_booking` and the candidate predicate make a second run a no-op.
 */
export async function backfillReservations(opts: { execute: boolean; before?: string | null; log?: (line: string) => void } = { execute: false }): Promise<ReservationBackfill> {
  const log = opts.log ?? (() => {});
  let cutoff = opts.before ?? null;
  if (!cutoff) {
    const { rows } = await db.query('SELECT MIN(created_at) AS first FROM professional_service_reservations');
    const first = rows[0]?.first;
    cutoff = first ? (first instanceof Date ? first.toISOString() : String(first)) : null;
  }
  const { rows } = await db.query(
    `SELECT ceb.id AS booking_id, ceb.gym_id, ceb.member_id, ceb.professional_service_id,
            ce.id AS event_id, ce.activity_type_id
       FROM calendar_event_bookings ceb
       JOIN calendar_events ce ON ce.id = ceb.calendar_event_id
      WHERE ceb.status = 'booked'
        AND ce.status = 'scheduled' AND ce.deleted_at IS NULL
        AND ce.starts_at > UTC_TIMESTAMP()
        AND (ceb.booked_by_member_id IS NULL OR ceb.booked_by_member_id = ceb.member_id)
        AND NOT EXISTS (SELECT 1 FROM professional_service_reservations r WHERE r.calendar_event_booking_id = ceb.id)
        ${cutoff ? 'AND ceb.booked_at < ?' : ''}
      ORDER BY ce.starts_at, ceb.id`,
    cutoff ? [new Date(cutoff)] : [],
  );
  const out: ReservationBackfill = { cutoff, candidates: rows.length, reserved: 0, no_available: 0, not_applicable: 0 };
  const ROLLBACK = Symbol('dry-run');
  for (const r of rows as any[]) {
    if (r.activity_type_id == null) { out.not_applicable++; continue; }
    try {
      await db.transaction(async (tx: Tx) => {
        const outcome = await reserveForBooking(
          tx, r.gym_id, Number(r.member_id), Number(r.booking_id), Number(r.event_id), Number(r.activity_type_id),
          r.professional_service_id == null ? null : Number(r.professional_service_id), 'System',
        );
        if (outcome === 'reserved') out.reserved++;
        else if (outcome === 'no_available') out.no_available++;
        else out.not_applicable++;
        log(`${opts.execute ? outcome : `would ${outcome}`} booking #${r.booking_id} (member ${r.member_id}, event ${r.event_id})`);
        if (!opts.execute) throw ROLLBACK;
      });
    } catch (err) {
      if (err !== ROLLBACK) throw err;
    }
  }
  return out;
}
