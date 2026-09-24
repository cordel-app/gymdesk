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

// ── #635 stage 9: can this Promotion be put back on? ─────────────────────────
//
// The issue thread's Q2 answer asks for Promotions that are "selectable and
// deselectable". Stage 7 only revoked; migration 183 makes the pair unique
// among *standing* applications, so a spent one can be agreed again — as a new
// application with its own snapshot, never by resurrecting the revoked row.
//
// This decides whether the card offers that, and nothing more: it is what the
// checkbox reads, so the frontend derives no rule of its own (CLAUDE.md). It is
// deliberately narrower than the apply path, which is the authority — stacking
// against whatever else is applied, plan targeting and
// `only_applicable_for_new_members` all stay there and surface as the server's
// message. What is answered here is only the part a card can state without
// re-running those checks: this application is spent, no other application of
// the same Promotion is standing in its place, and the Promotion itself is
// still live today (a `deleted`/`inactive` one, or one whose own window has
// closed, can never be agreed again, so offering it would only produce a 400).

export interface PromotionReapplicability {
  /** How the application reads today, from `promotionApplicationStatus()`. */
  displayStatus: PromotionApplicationStatus;
  /** Another application of the same Promotion on the same assignment is still standing. */
  hasStandingApplication: boolean;
  /** `promotions.lifecycle_status` as it is now — not the snapshot's. */
  promotionLifecycleStatus: string | null;
  /** The Promotion's *live* window, which is what a new application would be agreed inside. */
  promotionStartsAt: string | Date | null;
  promotionEndsAt: string | Date | null;
}

function asDate(value: string | Date | null): Date | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function canReapplyPromotion(
  application: PromotionReapplicability,
  now: Date = new Date(),
): boolean {
  // An `active` or `expired` application is still standing (`status =
  // 'applied'`): it is deselected by revoking it, not re-applied.
  if (application.displayStatus !== 'inactive') return false;
  if (application.hasStandingApplication) return false;
  if (application.promotionLifecycleStatus !== 'active') return false;
  const startsAt = asDate(application.promotionStartsAt);
  const endsAt = asDate(application.promotionEndsAt);
  if (startsAt != null && startsAt.getTime() > now.getTime()) return false;
  if (endsAt != null && endsAt.getTime() < now.getTime()) return false;
  return true;
}
