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
