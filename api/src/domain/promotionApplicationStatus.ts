// #635 stage 7: the status one *applied* Promotion reads as on the Assigned
// Plan it was applied to.
//
// `user_membership_promotions.status` only ever says whether the application
// is still standing ('applied') or was taken off ('revoked'). What the card
// has to show is narrower than the Promotion's own lifecycle and wider than
// that column: an application whose agreed window has run out is neither
// simply "applied" nor "revoked", it is spent.
//
// The window read here is the *snapshot's* (§16) — the one the assignment
// agreed to — so editing the Promotion's dates later cannot change how an
// existing application reads, exactly as it cannot change what it bills.
//
// The issue thread also names "incompatible". Nothing can persist in that
// state: a Promotion that does not stack with one already applied is refused
// at apply time (`validatePromotionStacking`, and the per-apply check in
// `membership-promotions.ts`), so an incompatible Promotion never becomes an
// application to display. It is therefore not a status of an applied
// Promotion, and is not produced here.

export type PromotionApplicationStatus = 'active' | 'inactive' | 'expired';

export interface PromotionApplicationForStatus {
  /** `user_membership_promotions.status` — 'applied' | 'consumed' | 'revoked'. */
  status: string;
  /** End of the agreed promotional window: the snapshot's, or the live one for a snapshot-less application. */
  ends_at: string | Date | null;
}

/**
 * - revoked (or consumed — no longer standing) → `inactive`
 * - still applied but past the end of its agreed window → `expired`
 * - still applied and inside it → `active`
 *
 * `now` is injectable so the caller can classify a whole list against one
 * instant rather than a moving one.
 */
export function promotionApplicationStatus(
  application: PromotionApplicationForStatus,
  now: Date = new Date(),
): PromotionApplicationStatus {
  if (application.status !== 'applied') return 'inactive';
  if (application.ends_at == null) return 'active';
  const endsAt = application.ends_at instanceof Date ? application.ends_at : new Date(application.ends_at);
  if (Number.isNaN(endsAt.getTime())) return 'active';
  return endsAt.getTime() < now.getTime() ? 'expired' : 'active';
}
