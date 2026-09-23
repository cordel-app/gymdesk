import {
  NewMemberAssignment,
  newMemberCutoff,
  qualifiesAsNewMember,
} from '../domain/newMemberEligibility';

/**
 * #634 §3 — the database side of the "Only applicable for new members" rule.
 *
 * The rule itself (which Assigned Plans count, and how the 12-month window is
 * measured) lives in `domain/newMemberEligibility.ts`; this module only reads
 * the Member's assignments and hands them over, so every enforcement point —
 * POST /user-memberships/:id/promotions, `applyPromotionToMembership` (which
 * covers assign-new-plan, POST /membership-plans/:id/assign's auto-apply and
 * POST /payments/apply-promotion) and #628's up-front
 * `validatePromotionSelection` — evaluates exactly the same thing.
 *
 * Only the assignments the Member *owns* (`user_memberships.member_id`) are
 * considered. A Member merely covered by somebody else's family plan
 * (`user_membership_members` with `is_owner = 0`) never booked a Membership
 * Plan of their own, which is what the answer in the issue thread measures.
 */

type Queryable = { query: (sql: string, params?: any[]) => Promise<{ rows: any[] }> };

/** Error message and status shared by all four enforcement points. */
export const NEW_MEMBERS_ONLY_ERROR = 'This promotion is only applicable for new members';

/**
 * Every Assigned Plan the Member owns, in the shape the rule needs. A Member
 * holds a handful of these, not a page of them, so they are evaluated in
 * memory rather than folded into each caller's SQL.
 */
export async function loadMemberAssignments(
  exec: Queryable, gymId: string, memberId: number,
): Promise<NewMemberAssignment[]> {
  const { rows } = await exec.query(
    `SELECT id, status, starts_at, ends_at, closed_at, created_at
     FROM user_memberships
     WHERE gym_id = ? AND member_id = ?`,
    [gymId, memberId],
  );
  return rows as NewMemberAssignment[];
}

/**
 * Whether the Member counts as "new" for a Promotion applied to
 * `excludeUserMembershipId` — the assignment being configured, which never
 * counts against its own Member.
 */
export async function isNewMember(
  exec: Queryable,
  gymId: string,
  memberId: number,
  excludeUserMembershipId: number,
  now: Date = new Date(),
): Promise<boolean> {
  const assignments = await loadMemberAssignments(exec, gymId, memberId);
  return qualifiesAsNewMember(assignments, newMemberCutoff(now), excludeUserMembershipId);
}

/** Stands in for the assignment about to be created; never a real row id. */
const PENDING_ASSIGNMENT_ID = -1;

/**
 * The same answer for an assignment that does not exist yet — #628's up-front
 * `validatePromotionSelection`, which runs before the Plan is assigned.
 *
 * The pending assignment is evaluated as if it were already there (and then
 * excluded, like any assignment being configured), so this agrees with the
 * check `applyPromotionToMembership` runs moments later on the real row. It
 * matters for one case: a terminal assignment carrying no end date is dated by
 * whatever replaced it (see domain/newMemberEligibility.ts), and the row about
 * to be created is exactly that successor. Without the stand-in, the selection
 * would pass and the apply would then refuse — with the Plan already assigned.
 */
export async function isNewMemberForNewAssignment(
  exec: Queryable, gymId: string, memberId: number, now: Date = new Date(),
): Promise<boolean> {
  const assignments = await loadMemberAssignments(exec, gymId, memberId);
  const pending: NewMemberAssignment = {
    id: PENDING_ASSIGNMENT_ID,
    status: 'active',
    starts_at: now,
    ends_at: null,
    closed_at: null,
    created_at: now,
  };
  return qualifiesAsNewMember([...assignments, pending], newMemberCutoff(now), PENDING_ASSIGNMENT_ID);
}
