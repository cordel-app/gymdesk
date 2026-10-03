import { db, Tx } from '../infra/db';
import { recordStatusChange } from './billing-events';
import {
  LIVE_ASSIGNMENT_STATUSES,
  LiveAssignment,
  LiveAssignmentStatus,
} from '../domain/oneActivePlan';

/**
 * #956 — the one enforcement point for "a member holds at most one Membership
 * Plan", shared by every path that creates a `user_memberships` row:
 * `POST /user-memberships`, `POST /user-memberships/:id/assign-new-plan` and
 * `POST /membership-plans/:id/assign`. The rules themselves live in
 * `domain/oneActivePlan.ts`; this module is the SQL half — the lock, the read
 * and the supersede — so no route decides either for itself.
 *
 * A new assignment path calls `findLiveAssignmentsForMembers()` **inside** the
 * same transaction as its INSERT and either answers the 409 or supersedes what
 * it found. Reading it outside the transaction would put a window between the
 * check and the insert in which a second request can assign the same member.
 */

/**
 * Every live assignment *covering* any of `memberIds`, locked for update.
 *
 * "Covering" is `user_membership_members`, not `user_memberships.member_id`
 * (#956 Q4): a family plan carries one row owned by one member and a covered-member
 * row per member, so a co-member of someone else's family plan already has a
 * plan. The owner's own `member_id` is read as well, because it is the column
 * `active_member_key` is derived from and a row written before #374's covered-member
 * table may carry no `user_membership_members` row at all.
 *
 * `FOR UPDATE` is what makes two concurrent replacements of the same member
 * serialise: the second blocks on the first's lock and then re-reads a row that
 * is no longer live. A member with *no* live assignment locks nothing here —
 * that case is the UNIQUE index's (migration 213).
 */
export async function findLiveAssignmentsForMembers(
  tx: Tx,
  gymId: string,
  memberIds: readonly number[],
  opts?: { excludeUserMembershipId?: number },
): Promise<LiveAssignment[]> {
  if (memberIds.length === 0) return [];
  const idPlaceholders = memberIds.map(() => '?').join(',');
  const statusPlaceholders = LIVE_ASSIGNMENT_STATUSES.map(() => '?').join(',');
  const params: any[] = [
    gymId,
    ...LIVE_ASSIGNMENT_STATUSES,
    ...memberIds,
    gymId,
    ...memberIds,
  ];
  let sql =
    `SELECT um.id, um.member_id, um.membership_plan_id, um.status,
            DATE_FORMAT(um.starts_at, '%Y-%m-%d') AS starts_at,
            DATE_FORMAT(um.ends_at, '%Y-%m-%d') AS ends_at
     FROM user_memberships um
     WHERE um.gym_id = ?
       AND um.status IN (${statusPlaceholders})
       AND (um.member_id IN (${idPlaceholders})
            OR EXISTS (SELECT 1 FROM user_membership_members umm
                       WHERE umm.user_membership_id = um.id AND umm.gym_id = ?
                         AND umm.member_id IN (${idPlaceholders})))`;
  if (opts?.excludeUserMembershipId != null) {
    sql += ' AND um.id <> ?';
    params.push(opts.excludeUserMembershipId);
  }
  // Ordered so `current_plan` in the 409 body, and the audit trail of a
  // multi-member assignment, are deterministic rather than MySQL's choice.
  sql += ' ORDER BY um.starts_at DESC, um.id DESC FOR UPDATE';
  const { rows } = await tx.query<{
    id: number;
    member_id: number;
    membership_plan_id: number | null;
    status: LiveAssignmentStatus;
    starts_at: string;
    ends_at: string | null;
  }>(sql, params);
  if (rows.length === 0) return [];

  // The names the confirmation dialog shows. Read after the lock and without
  // one of their own: a Plan or Member renamed between the two reads changes
  // the words in a warning, never which assignment is replaced.
  const planIds = [...new Set(rows.map((r) => r.membership_plan_id).filter((id): id is number => id != null))];
  const planNames = new Map<number, string>();
  if (planIds.length > 0) {
    const { rows: planRows } = await tx.query<{ id: number; name: string }>(
      `SELECT id, name FROM membership_plans
       WHERE gym_id = ? AND id IN (${planIds.map(() => '?').join(',')})`,
      [gymId, ...planIds],
    );
    for (const plan of planRows) planNames.set(plan.id, plan.name);
  }
  const ownerIds = [...new Set(rows.map((r) => r.member_id))];
  const memberNames = new Map<number, string>();
  const { rows: memberRows } = await tx.query<{ id: number; name: string }>(
    `SELECT id, name FROM members
     WHERE gym_id = ? AND id IN (${[...ownerIds, ...memberIds].map(() => '?').join(',')})`,
    [gymId, ...ownerIds, ...memberIds],
  );
  for (const member of memberRows) memberNames.set(member.id, member.name);

  // Which of the *requested* members each conflict blocks. A family plan can
  // cover several of them at once; the first is enough to name in the warning,
  // and the assignment is cancelled once either way.
  const covered = new Map<number, number>();
  const { rows: coveredRows } = await tx.query<{ user_membership_id: number; member_id: number }>(
    `SELECT user_membership_id, member_id FROM user_membership_members
     WHERE gym_id = ? AND user_membership_id IN (${rows.map(() => '?').join(',')})
       AND member_id IN (${idPlaceholders})
     ORDER BY member_id ASC`,
    [gymId, ...rows.map((r) => r.id), ...memberIds],
  );
  for (const row of coveredRows) {
    if (!covered.has(row.user_membership_id)) covered.set(row.user_membership_id, row.member_id);
  }

  return rows.map((row) => {
    const blockedMemberId = covered.get(row.id) ?? row.member_id;
    return {
      id: Number(row.id),
      owner_member_id: Number(row.member_id),
      owner_member_name: memberNames.get(Number(row.member_id)) ?? null,
      blocked_member_id: Number(blockedMemberId),
      blocked_member_name: memberNames.get(Number(blockedMemberId)) ?? null,
      membership_plan_id: row.membership_plan_id != null ? Number(row.membership_plan_id) : null,
      membership_plan_name: row.membership_plan_id != null
        ? planNames.get(Number(row.membership_plan_id)) ?? null
        : null,
      status: row.status,
      starts_at: row.starts_at,
      ends_at: row.ends_at,
    };
  });
}

/**
 * Cancel the live assignments a confirmed replacement supersedes, in the
 * caller's transaction and before its INSERT, so there is no instant at which
 * the member holds two.
 *
 * #956 Q3: `cancelled` (not `expired`, which is what `assign-new-plan` wrote
 * before this ticket — a superseded plan is cancelled by a person, and the
 * screens already label `cancelled` that way), `closed_at` stamped now exactly
 * as `POST /:id/close` does, and `ends_at` set to the new plan's `starts_at` so
 * the two plans meet at one date and never overlap. The admin-set `ends_at` is
 * overwritten deliberately: the replacement, not the original intention, is
 * when this plan ended.
 *
 * Nothing else about the row is touched — its snapshot, its promotions, its
 * billing events and its `next_billing_date` are the record of what it billed
 * (#635 §16), and a `cancelled` row is outside the nightly run's
 * `WHERE status = 'active'`, so no further charge can come from it.
 */
export async function supersedeLiveAssignments(
  tx: Tx,
  args: {
    gymId: string;
    conflicts: readonly LiveAssignment[];
    newStartsAt: string;
    source: string;
    actorUserId: string | null;
  },
): Promise<void> {
  for (const conflict of args.conflicts) {
    await tx.query(
      `UPDATE user_memberships
       SET status = 'cancelled', closed_at = UTC_TIMESTAMP(), ends_at = ?
       WHERE id = ? AND gym_id = ?`,
      [args.newStartsAt, conflict.id, args.gymId],
    );
    await recordStatusChange(tx, {
      gymId: args.gymId,
      userMembershipId: conflict.id,
      memberId: conflict.owner_member_id,
      previousStatus: conflict.status,
      newStatus: 'cancelled',
      source: args.source,
      actorUserId: args.actorUserId,
    });
  }
}

/**
 * The name the 409's warning calls the plan being assigned. Read outside the
 * transaction and after it: it is wording, never a decision, so a Plan renamed
 * in between changes the sentence and nothing else. `null` for a Plan that has
 * vanished, which `activePlanConflictBody()` words around rather than failing on.
 */
export async function membershipPlanName(gymId: string, planId: number): Promise<string | null> {
  const { rows } = await db.query<{ name: string }>(
    'SELECT name FROM membership_plans WHERE id = ? AND gym_id = ?',
    [planId, gymId],
  );
  return rows[0]?.name ?? null;
}
