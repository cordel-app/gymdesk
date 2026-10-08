import type { ProfessionalServiceGrantRow } from './memberProfessionalServices';

/**
 * #1227 stage 1: a staff correction of a Member's Professional Service balance.
 * Pure — the SQL half is `api/member-professional-services.ts`.
 *
 * The balance is still the derived one (grants less the consumption ledger);
 * an adjustment is one more source of it, never a second balance. Staff enter
 * the **new balance** and the ledger stores the signed delta with the balance
 * before and after (the thread's Q3).
 *
 * Per Professional Service the adjustments net to one number:
 *   - net > 0 → a `manual_adjustment` grant of that many sessions (spent like
 *     any grant, so it appears in the consumption ledger under that kind);
 *   - net < 0 → the same number of sessions is taken off the service's other
 *     grants, last in spend order first. A grant shared by several services
 *     (migration 153's mixed packages) is reduced for all of them, which is the
 *     overlap note of `memberProfessionalServices.ts` and not a new rule.
 */

export const MANUAL_ADJUSTMENT_KIND = 'manual_adjustment' as const;
export const ADJUSTMENT_REASON_MAX_LENGTH = 255;
/** The sentinel `reference_id` of the single manual-adjustment grant per service. */
export const MANUAL_ADJUSTMENT_REFERENCE_ID = 0;

export interface AdjustmentInput {
  new_balance: number;
  reason: string | null;
}

/** A request's body, judged in one place: a bad value is a message, never a coercion. */
export function parseAdjustmentInput(body: unknown): AdjustmentInput | { error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const value = b.new_balance;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    return { error: 'new_balance must be a non-negative integer' };
  }
  let reason: string | null = null;
  if (b.reason !== undefined && b.reason !== null) {
    if (typeof b.reason !== 'string') return { error: 'reason must be a string' };
    const trimmed = b.reason.trim();
    if (trimmed.length > ADJUSTMENT_REASON_MAX_LENGTH) {
      return { error: `reason must be at most ${ADJUSTMENT_REASON_MAX_LENGTH} characters` };
    }
    reason = trimmed || null;
  }
  return { new_balance: value, reason };
}

export interface AdjustmentRow {
  professional_service_id: number;
  delta: number | string;
}

/** The net adjustment per Professional Service. */
export function netAdjustments(rows: AdjustmentRow[]): Map<number, number> {
  const net = new Map<number, number>();
  for (const r of rows) {
    net.set(r.professional_service_id, (net.get(r.professional_service_id) ?? 0) + Number(r.delta));
  }
  return net;
}

/**
 * Fold the net adjustments into the grant rows (before consumption is
 * applied). `spendOrder` ranks the kinds so a negative adjustment takes sessions
 * from the grant that would be spent last.
 */
export function applyAdjustmentsToGrants(
  grants: ProfessionalServiceGrantRow[],
  net: Map<number, number>,
  serviceNames: Map<number, string>,
  spendOrder: readonly string[],
): ProfessionalServiceGrantRow[] {
  let rows = grants.map((g) => ({ ...g }));
  for (const [serviceId, amount] of net) {
    if (amount > 0) {
      rows.push({
        professional_service_id: serviceId,
        professional_service_name: serviceNames.get(serviceId) ?? '',
        kind: MANUAL_ADJUSTMENT_KIND,
        reference_id: MANUAL_ADJUSTMENT_REFERENCE_ID,
        product_id: 0,
        product_name: '',
        sessions: amount,
      });
    } else if (amount < 0) {
      let toRemove = -amount;
      const mine = rows
        .filter((r) => r.professional_service_id === serviceId && Number(r.sessions) > 0)
        .sort((a, b) => {
          const rank = spendOrder.indexOf(b.kind) - spendOrder.indexOf(a.kind);
          return rank !== 0 ? rank : b.reference_id - a.reference_id;
        });
      for (const row of mine) {
        if (toRemove <= 0) break;
        const take = Math.min(Number(row.sessions), toRemove);
        row.sessions = Number(row.sessions) - take;
        toRemove -= take;
      }
    }
  }
  return rows;
}

export type BalanceHistoryKind = 'adjustment' | 'consumption';

export interface BalanceHistoryEntry {
  kind: BalanceHistoryKind;
  at: string;
  /** Signed: an adjustment's delta, `-1` for a consumed session, `+1` for a returned one. */
  quantity: number;
  /** `attendance` | `late_cancel` | `no_show` | `returned` for a consumption; the staff reason for an adjustment. */
  reason: string | null;
  balance_before: number | null;
  balance_after: number | null;
  actor: string | null;
}

/** Newest first; ties keep the order given. */
export function sortHistory(entries: BalanceHistoryEntry[]): BalanceHistoryEntry[] {
  return [...entries].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}
