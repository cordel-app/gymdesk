/**
 * #1582 stage 1 — the one rule for "which ProductSet is this member's current one".
 *
 * Pure: it takes the owner's ProductSet rows and answers. The database already
 * guarantees one `active` and one in-flight (`draft` / `pending_payment`)
 * version per owner (migration 246's UNIQUE generated columns), so more than one
 * of either is a corrupt state that is reported (`ambiguous`), never papered
 * over by picking one.
 *
 * The in-flight version outranks the active one because that is the
 * configuration the member card is working on (#1463). A plan's status is the
 * snapshot's and the version's status is `product_sets.status`; this module
 * compares neither with the other and never synchronises them.
 */
import { isInFlight, isProductSetStatus } from './productSet';

export interface ResolvableProductSet {
  id: number;
  status: string;
}

export type CurrentProductSetResolution<T extends ResolvableProductSet> =
  | { kind: 'none' }
  | { kind: 'no_active'; history: T[] }
  | { kind: 'current'; current: T; history: T[] }
  | { kind: 'ambiguous'; reason: 'multiple_active' | 'multiple_in_flight'; candidates: T[] };

/** `history` is every `superseded` version, in the order given. */
export function resolveCurrentProductSet<T extends ResolvableProductSet>(
  sets: readonly T[],
): CurrentProductSetResolution<T> {
  if (sets.length === 0) return { kind: 'none' };
  const known = sets.filter((s) => isProductSetStatus(s.status));
  const inFlight = known.filter((s) => isInFlight(s.status as any));
  const active = known.filter((s) => s.status === 'active');
  const history = known.filter((s) => s.status === 'superseded');
  if (inFlight.length > 1) return { kind: 'ambiguous', reason: 'multiple_in_flight', candidates: inFlight };
  if (active.length > 1) return { kind: 'ambiguous', reason: 'multiple_active', candidates: active };
  const current = inFlight[0] ?? active[0];
  if (!current) return { kind: 'no_active', history };
  return { kind: 'current', current, history };
}
