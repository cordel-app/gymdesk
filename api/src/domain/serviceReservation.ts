import { ProfessionalServiceGrantRow } from './memberProfessionalServices';

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
}

/** Grants with the reserved units taken off, for choosing what a new booking holds. */
export function availableGrants(
  rows: ProfessionalServiceGrantRow[],
  reserved: ReservedTotal[],
): ProfessionalServiceGrantRow[] {
  const held = new Map<string, number>();
  for (const r of reserved) {
    const k = `${r.source_kind}:${r.source_reference_id}`;
    held.set(k, (held.get(k) ?? 0) + Number(r.reserved));
  }
  return rows.map((row) => {
    const used = held.get(`${row.kind}:${row.reference_id}`) ?? 0;
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
