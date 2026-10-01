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

/**
 * #927 — the Member's own `New Member` status, for one Member and for a page of
 * them.
 *
 * Nothing is stored: the status is derived on every read, so it tracks both the
 * Member's Membership history and the passing of the window with no writer at
 * all (§3's last bullet, §4 — it cannot be edited because there is nothing to
 * edit). And it is derived by `qualifiesAsNewMember()`, the same pure rule the
 * four Promotion apply paths run, so §5's "avoid implementing a separate New
 * Member calculation inside Promotions" holds in the other direction too —
 * there is no second SQL copy of the rule here, the mistake
 * `latestEnrollmentStatusSql()` exists to prevent.
 *
 * Nothing is excluded either: a Member-level answer has no assignment being
 * configured, so a Member with a live plan reads as not new.
 */
export async function isNewMemberStatus(
  exec: Queryable, gymId: string, memberId: number, now: Date = new Date(),
): Promise<boolean> {
  const assignments = await loadMemberAssignments(exec, gymId, memberId);
  return qualifiesAsNewMember(assignments, newMemberCutoff(now), null);
}

/**
 * The same answer for every Member of a list, in **one** query rather than one
 * per row — `GET /members` returns a page of Members and a per-row round trip
 * would make the list's cost linear in its length.
 *
 * A Member with no assignments has no row here at all, which is exactly the
 * ticket's first example: never had a Membership Plan ⇒ New Member. So the map
 * answers `true` for an id it never saw, and callers may read it for any Member
 * of the gym.
 */
export async function newMemberStatusByMember(
  exec: Queryable, gymId: string, memberIds: readonly number[], now: Date = new Date(),
): Promise<Map<number, boolean>> {
  const flags = new Map<number, boolean>();
  const ids = Array.from(new Set(memberIds.map((id) => Number(id)))).filter((id) => Number.isFinite(id));
  if (ids.length === 0) return flags;

  const { rows } = await exec.query(
    `SELECT member_id, id, status, starts_at, ends_at, closed_at, created_at
     FROM user_memberships
     WHERE gym_id = ? AND member_id IN (${ids.map(() => '?').join(',')})`,
    [gymId, ...ids],
  );

  const byMember = new Map<number, NewMemberAssignment[]>();
  for (const row of rows as (NewMemberAssignment & { member_id: number })[]) {
    const memberId = Number(row.member_id);
    const list = byMember.get(memberId);
    if (list) list.push(row);
    else byMember.set(memberId, [row]);
  }

  const cutoff = newMemberCutoff(now);
  for (const id of ids) {
    flags.set(id, qualifiesAsNewMember(byMember.get(id) ?? [], cutoff, null));
  }
  return flags;
}
