import { ProfessionalServiceGrantRow } from './memberProfessionalServices';
import { grantKey } from './serviceConsumption';

/**
 * #2605 stage 1: pure rules of the Professional Service reservation.
 * A booking reserves one unit; `sessions` on a grant row is the remaining
 * balance (grants minus consumption), so reserving never changes it —
 * only what is still *available* to book.
 */
export interface ReservedTotal {
  source_kind: string;
  source_reference_id: number;
  reserved: number;
  /** #2670 stage 2: the grant holder the unit is held against (absent for the family's manual adjustment). */
  member_id?: number | null;
}

/**
 * #2851: a `reserved` row holds a unit only while its booking still does: the
 * booking is `booked`, its occurrence is neither cancelled nor deleted, and no
 * unreturned spend has already been written for it (a spend *is* the unit, so
 * counting both would take it off the wallet twice). Every reader of the
 * reservations asks this, so a row a cancel path forgot to release — an Activity
 * discontinued, a schedule rule edited, a spend at attendance before the
 * event-start pass ran — stops making the member's balance read "all booked".
 */
export function liveReservationSql(alias: string): string {
  return `${alias}.status = 'reserved'
    AND EXISTS (SELECT 1 FROM calendar_event_bookings lrb
                  JOIN calendar_events lre ON lre.id = lrb.calendar_event_id
                 WHERE lrb.id = ${alias}.calendar_event_booking_id AND lrb.status = 'booked'
                   AND lre.status <> 'cancelled' AND lre.deleted_at IS NULL)
    AND NOT EXISTS (SELECT 1 FROM professional_service_consumptions lrc
                     WHERE lrc.calendar_event_booking_id = ${alias}.calendar_event_booking_id AND lrc.returned_at IS NULL)`;
}

/** Grants with the reserved units taken off, for choosing what a new booking holds. */
export function availableGrants(
  rows: ProfessionalServiceGrantRow[],
  reserved: ReservedTotal[],
): ProfessionalServiceGrantRow[] {
  const held = new Map<string, number>();
  for (const r of reserved) {
    const k = grantKey(r.source_kind, r.source_reference_id, r.member_id);
    held.set(k, (held.get(k) ?? 0) + Number(r.reserved));
  }
  return rows.map((row) => {
    const used = held.get(grantKey(row.kind, row.reference_id, row.holder_member_id)) ?? 0;
    return used > 0 ? { ...row, sessions: Number(row.sessions) - used } : row;
  });
}

/** total = available + booked, for one service. */
export function reservationBalance(total: number, booked: number): { total: number; booked: number; available: number } {
  const t = Math.max(0, Number(total));
  const b = Math.min(t, Math.max(0, Number(booked)));
  return { total: t, booked: b, available: t - b };
}

/** Reserved rows counted per Professional Service (the service the booking named). */
export interface BookedByService {
  professional_service_id: number;
  booked: number;
}

export interface ServiceBalanceView {
  professional_service_id: number;
  /** Remaining entitlement: available + booked (the wallet's own `sessions`). */
  total: number;
  /** Units held by future bookings (`reserved` rows). */
  booked: number;
  /** Units a new booking may still take: total - booked, never below zero. */
  available: number;
}

/**
 * #2605 stage 3: the one place the three figures a balance is shown as are
 * derived — `Training Individual: 5 items (0 available + 5 booked)`. `total`
 * is the wallet's remaining balance (grants minus consumption), `booked` the
 * member's `reserved` rows naming that service, `available` the difference.
 * Nothing is stored; a service with reservations but no balance reads 0/0/0.
 */
export function serviceBalanceViews(
  balances: Array<{ professional_service_id: number; sessions: number }>,
  bookedByService: BookedByService[],
): Map<number, ServiceBalanceView> {
  const booked = new Map<number, number>();
  for (const b of bookedByService) {
    const id = Number(b.professional_service_id);
    booked.set(id, (booked.get(id) ?? 0) + Number(b.booked));
  }
  const out = new Map<number, ServiceBalanceView>();
  for (const b of balances) {
    const id = Number(b.professional_service_id);
    out.set(id, { professional_service_id: id, ...reservationBalance(Number(b.sessions), booked.get(id) ?? 0) });
  }
  for (const [id, n] of booked) {
    if (!out.has(id)) out.set(id, { professional_service_id: id, ...reservationBalance(0, n) });
  }
  return out;
}
