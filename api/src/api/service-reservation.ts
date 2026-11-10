import { Tx, db } from '../infra/db';
import { spendSessionForBooking } from './service-consumption';
import { loadRequiredServices } from './activity-eligibility';
import { loadMemberProfessionalServiceGrants } from '../domain/memberProfessionalServices';
import { chooseSpendGrant } from '../domain/serviceConsumption';
import { availableGrants } from '../domain/serviceReservation';

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
