/**
 * #634 §3 — "Only applicable for new members"; #927 — the Member's own
 * `New Member` status.
 *
 * `promotions.only_applicable_for_new_members` has been stored since #633
 * (migration 163) and read by nothing. The definition of "new", from the #634
 * issue thread:
 *
 *   "We must understand 'new user' as a member that books his/her first
 *    membership plan in 12 months. If a user was member of the gym 12 months
 *    ago and now is coming back, the flag only applicable to new users will
 *    apply."
 *
 * #927 made that status a Member-level, read-only field of the Member Profile
 * and shortened the window to **six** months — "A member is considered a New
 * Member when they have not had an active Membership Plan during the previous
 * 6 months" — and the answer on its thread settled that the same number
 * governs Promotions: *"6 months here and in promotions"*. There is therefore
 * one window, not two: the badge the Members list shows and the window the
 * four Promotion apply paths enforce are the same `NEW_MEMBER_WINDOW_MONTHS`,
 * which is what §5 ("avoid implementing a separate New Member calculation
 * inside Promotions") asks for. A member who left between 6 and 12 months ago
 * reads as new, and a new-members-only Promotion now applies to them.
 *
 * So the rule is about the Member's *recent* history, not their first-ever
 * assignment: a Member qualifies when none of their other Assigned Plans puts
 * them inside the gym during the trailing window. An Assigned Plan counts
 * against the Member when any of these holds:
 *
 *   - it is still live (active / paused) — they
 *     hold it right now, however long ago it started;
 *   - it started on or after the cutoff — they booked a plan inside the window;
 *   - it ended on or after the cutoff — they were still a member inside it.
 *
 * Pure on purpose — every date comparison lives here, so the rule can be
 * unit-tested without a database and the callers (the promotion apply paths,
 * the Member configuration read and the Members list) can never drift apart.
 */

/** The trailing window, in months, a Member must have been away for (#927). */
export const NEW_MEMBER_WINDOW_MONTHS = 6;

/**
 * The statuses that mean the Member holds the plan right now. Same list as
 * `LIVE_STATUSES` in member-membership-configuration.ts and
 * `SIMULATED_STATUSES` in billing-simulation.ts — an assignment that still has
 * billing ahead of it is, by definition, a current membership.
 */
const LIVE_STATUSES = new Set(['active', 'paused']);

/**
 * The pre-activation status (#1108 stage 1). A Draft is deliberately not in
 * `LIVE_STATUSES` and is also not "recent": see `countsAsRecentMembership()`.
 */
const DRAFT_STATUS = 'draft';
/** #1108 stage 2: a row awaiting its first payment is a Draft that is locked — still nobody's plan. */
const PENDING_PAYMENT_STATUS = 'pending_payment';

export interface NewMemberAssignment {
  id: number;
  status: string;
  /** DATE column, NOT NULL. */
  starts_at: string | Date;
  /** DATE column, nullable — the planned/actual end an admin sets. */
  ends_at: string | Date | null;
  /** DATETIME, nullable — stamped by the Close transition (#511 stage 1). */
  closed_at: string | Date | null;
  /** DATETIME, NOT NULL — when the assignment was created. */
  created_at: string | Date;
}

/**
 * mysql2 hands DATE/DATETIME columns back as either a string or a Date
 * depending on the connection's timezone config (same note as
 * user-memberships.ts). Everything is compared as a YYYY-MM-DD string, which
 * sorts lexicographically, so the two representations can't disagree.
 */
function toDateOnly(value: string | Date | null | undefined): string | null {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

/** Same, to second precision, for ordering two rows created on one day. */
function toTimestamp(value: string | Date | null | undefined): string | null {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : String(value).replace(' ', 'T');
}

/**
 * The first day that still counts as "recent" — `now` minus the window, as
 * YYYY-MM-DD. The day-of-month is clamped to the target month's length, so a
 * 29 February never rolls forward into March.
 */
export function newMemberCutoff(now: Date, months: number = NEW_MEMBER_WINDOW_MONTHS): string {
  const target = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months, 1));
  const daysInTargetMonth = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(now.getUTCDate(), daysInTargetMonth));
  return target.toISOString().slice(0, 10);
}

/**
 * When a terminal assignment stopped covering its Member, or null when that
 * cannot be established.
 *
 * `ends_at` and `closed_at` answer it directly for a plan that ran its course
 * or was closed. Neither is set by assign-new-plan's supersede, which stamps
 * `status = 'expired'` and nothing else — so a superseded row is dated by the
 * assignment that replaced it: it stopped covering the Member exactly when its
 * successor was created. Without that, a Member whose membership has been
 * renewed through Assign New Plan for years would read as "new", because every
 * superseded row of theirs carries an old `starts_at` and no end date at all.
 *
 * `siblings` is the Member's full assignment list, including the one being
 * excluded from the eligibility check — the excluded row is usually the very
 * successor that dates the others.
 */
function terminalEnd(
  assignment: NewMemberAssignment, siblings: readonly NewMemberAssignment[],
): string | null {
  const endsAt = toDateOnly(assignment.ends_at);
  if (endsAt !== null) return endsAt;
  const closedAt = toDateOnly(assignment.closed_at);
  if (closedAt !== null) return closedAt;

  const createdAt = toTimestamp(assignment.created_at);
  if (createdAt === null) return null;
  let successor: string | null = null;
  for (const sibling of siblings) {
    if (Number(sibling.id) === Number(assignment.id)) continue;
    const siblingCreated = toTimestamp(sibling.created_at);
    if (siblingCreated === null || siblingCreated <= createdAt) continue;
    if (successor === null || siblingCreated < successor) successor = siblingCreated;
  }
  return successor === null ? null : successor.slice(0, 10);
}

/** Does this Assigned Plan make its Member a current or recent member? */
export function countsAsRecentMembership(
  assignment: NewMemberAssignment, cutoff: string, siblings: readonly NewMemberAssignment[] = [],
): boolean {
  // #1108 stage 1: a **Draft counts as nothing**. It is a purchase nobody has
  // committed, so it neither makes its Member current nor ends their absence —
  // and the test below it would have disqualified every Draft outright, since a
  // Draft's `starts_at` is by definition inside the window. Checked before the
  // live-status set rather than relying on `draft` being absent from it, because
  // that absence alone is not what makes this right.
  if (assignment.status === DRAFT_STATUS || assignment.status === PENDING_PAYMENT_STATUS) return false;
  if (LIVE_STATUSES.has(assignment.status)) return true;

  const startsAt = toDateOnly(assignment.starts_at);
  if (startsAt !== null && startsAt >= cutoff) return true;

  const end = terminalEnd(assignment, siblings);
  return end !== null && end >= cutoff;
}

/**
 * `excludeUserMembershipId` is the assignment the Promotion is about to be
 * applied to — it must never count against its own Member. Pass `null` for the
 * Member's own `New Member` status (#927): a Member-level answer has no
 * assignment being configured, so a Member holding a live plan reads as not
 * new, which is the ticket's fourth example. Assigning a plan
 * creates the assignment first and applies the Promotions right after
 * (assign-new-plan, POST /membership-plans/:id/assign), so without the
 * exclusion a brand-new Member would be disqualified by the very plan the
 * Promotion is being attached to. Pass null when the assignment does not exist
 * yet (#628's up-front `validatePromotionSelection`).
 */
export function qualifiesAsNewMember(
  assignments: readonly NewMemberAssignment[],
  cutoff: string,
  excludeUserMembershipId: number | null = null,
): boolean {
  return !assignments.some(
    (a) => Number(a.id) !== excludeUserMembershipId && countsAsRecentMembership(a, cutoff, assignments),
  );
}
