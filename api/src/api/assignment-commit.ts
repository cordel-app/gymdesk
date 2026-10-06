import type { Tx } from '../infra/db';
import { recordStatusChange } from './billing-events';
import { rollStaleNextBillingDateForward } from '../domain/nextBillingDateStamp';
import {
  DRAFT_ASSIGNMENT_STATUS,
  PENDING_PAYMENT_ASSIGNMENT_STATUS,
  PRE_ACTIVATION_STATUSES,
  isPreActivationStatus,
} from '../domain/assignmentCommit';
import {
  LiveAssignment,
  supersedeStartsAtError,
} from '../domain/oneActivePlan';
import { findLiveAssignmentsForMembers, supersedeLiveAssignments } from './one-active-plan';

/**
 * #1108 — the one `-> active` commit of an Assigned Plan, as a function three
 * callers share.
 *
 * Stage 1 put this transition in `POST /user-memberships/:id/activate` and said
 * why it is a route of its own rather than a `status` flip: committing is the
 * moment #956's one-plan rule is enforced, because the Member may have been
 * holding another plan all along while this one was configured. Stage 2 adds two
 * more callers to the same transition rather than a second commit — Save & Pay
 * when the first cycle owes nothing, and the payment webhook when the money
 * arrives — so the rule is this module and the routes are callers of it.
 *
 * It is the **I/O** half of `api/src/domain/assignmentCommit.ts`, which declares
 * the two pre-activation statuses and what they mean. Everything here runs
 * inside the caller's transaction, on the caller's handle: the webhook commits
 * the assignment in the very transaction that records the payment, so a member
 * cannot end up charged with their plan left unpaid-looking, and a staff commit
 * supersedes the plan it replaces in the same breath as it activates.
 */

/** Who is committing, for the ledger row this writes. */
export interface CommitActor {
  /** `billing_events.source` — `sourceForRole()`'s answer, or `'provider'`. */
  source: string;
  /** The acting user, or `null` when the provider's webhook is the caller. */
  actorUserId: string | null;
}

/** What `commitAssignment()` found and did. */
export type CommitOutcome =
  /** No such assignment in this gym. */
  | { kind: 'not_found' }
  /**
   * The row is not in a status this commit moves out of. `status` is what it
   * actually holds, so a caller can say so rather than answering a silent no-op
   * — and it is also what the loser of two concurrent commits gets, because the
   * UPDATE carries the expected statuses in its own WHERE.
   */
  | { kind: 'not_committable'; status: string }
  /**
   * The Member (or one of the Members this assignment covers) holds a live plan
   * and the caller did not confirm replacing it. Nothing has been written.
   */
  | { kind: 'conflict'; conflicts: LiveAssignment[] }
  /** Replacing would date the superseded row's end before its own start. */
  | { kind: 'bad_date'; message: string }
  /** Committed. `superseded` are the assignments this cancelled, if any. */
  | { kind: 'activated'; superseded: number[]; previousStatus: string };

/** The one row this commit needs, locked. */
interface CommittableRow {
  id: number;
  member_id: number;
  status: string;
  starts_at: string;
}

/**
 * Read and lock the assignment a commit (or a Save & Pay) is about.
 *
 * Shared so that both read the same columns under the same `FOR UPDATE`: the
 * decision has to be taken from the locked row and never from one read before a
 * provider round trip (#785's rule for the dunning pair, the same reason).
 */
export async function lockAssignmentForCommit(
  tx: Tx, gymId: string, id: number | string,
): Promise<CommittableRow | null> {
  const { rows } = await tx.query<CommittableRow>(
    `SELECT id, member_id, status, DATE_FORMAT(starts_at, '%Y-%m-%d') AS starts_at
       FROM user_memberships WHERE id = ? AND gym_id = ? FOR UPDATE`,
    [id, gymId],
  );
  return rows[0] ?? null;
}

/**
 * Every Member this assignment covers, not just the one who owns it (#956 Q4).
 *
 * A family assignment is one `user_memberships` row owned by one Member plus a
 * `user_membership_members` row per covered Member, so committing it has to find
 * — and `confirm` has to cancel — the plans of all of them at once. Reading the
 * owner alone would leave a covered Member holding both their own plan and this
 * one, which is the overlap `active_member_key` cannot express. The owner is
 * unioned in because a row written before #374's covered-member table may carry
 * no `user_membership_members` row at all.
 */
export async function coveredMemberIds(
  tx: Tx, gymId: string, assignment: Pick<CommittableRow, 'id' | 'member_id'>,
): Promise<number[]> {
  const { rows } = await tx.query<{ member_id: number }>(
    `SELECT member_id FROM user_membership_members
      WHERE user_membership_id = ? AND gym_id = ?`,
    [assignment.id, gymId],
  );
  return [...new Set([
    Number(assignment.member_id),
    ...rows.map((r) => Number(r.member_id)),
  ])];
}

/**
 * The live plans that have to stop for this assignment to be the Member's only
 * one. Empty when there are none; the assignment never appears among its own
 * conflicts, and neither does another pre-activation row, since
 * `LIVE_ASSIGNMENT_STATUSES` names neither `draft` nor `pending_payment`.
 */
export async function liveConflictsFor(
  tx: Tx, gymId: string, assignment: CommittableRow,
): Promise<LiveAssignment[]> {
  return findLiveAssignmentsForMembers(
    tx, gymId, await coveredMemberIds(tx, gymId, assignment),
    { excludeUserMembershipId: Number(assignment.id) },
  );
}

/**
 * Commit an assignment: `draft | pending_payment -> active`.
 *
 * Both pre-activation statuses are accepted, because stage 2 has two ways in and
 * neither is a different commit: a Draft whose first cycle owes nothing is
 * activated straight out of Save & Pay, and one that owed money has been locked
 * as `pending_payment` since Save & Pay raised the charge and is activated by the
 * webhook that confirms it.
 *
 * `confirm` is the caller's acknowledgement that the Member's current plan may be
 * cancelled. The webhook passes `true`: by the time it runs the member has paid,
 * and refusing to activate a membership somebody has been charged for — because
 * of a conflict staff already confirmed at Save & Pay, or one created in the
 * meantime — would leave money taken for a plan that never started. Every
 * staff-initiated path passes `false` first and answers the 409 the replacement
 * dialog is drawn from.
 */
export async function commitAssignment(
  tx: Tx,
  args: {
    gymId: string;
    id: number | string;
    actor: CommitActor;
    confirm: boolean;
  },
): Promise<CommitOutcome> {
  const row = await lockAssignmentForCommit(tx, args.gymId, args.id);
  if (!row) return { kind: 'not_found' };
  if (!isPreActivationStatus(row.status)) {
    return { kind: 'not_committable', status: row.status };
  }

  const conflicts = await liveConflictsFor(tx, args.gymId, row);
  if (conflicts.length > 0) {
    if (!args.confirm) return { kind: 'conflict', conflicts };
    const dateError = supersedeStartsAtError(row.starts_at, conflicts);
    if (dateError) return { kind: 'bad_date', message: dateError };
    await supersedeLiveAssignments(tx, {
      gymId: args.gymId,
      conflicts,
      newStartsAt: row.starts_at,
      source: args.actor.source,
      actorUserId: args.actor.actorUserId,
    });
  }

  const statusMarks = PRE_ACTIVATION_STATUSES.map(() => '?').join(',');
  const { rowCount } = await tx.query(
    `UPDATE user_memberships
        SET status = 'active', failed_attempts = 0, last_failed_at = NULL
      WHERE id = ? AND gym_id = ? AND status IN (${statusMarks})`,
    [row.id, args.gymId, ...PRE_ACTIVATION_STATUSES],
  );
  if (rowCount === 0) return { kind: 'not_committable', status: row.status };

  // #790: an assignment joining the run's schedule is never put on a cycle that
  // has already gone by. A Draft carries no `next_billing_date` at all — the
  // first payment stamps it — so this is a no-op on the ordinary path and the
  // one place that answers it either way.
  await rollStaleNextBillingDateForward(tx, Number(row.id), args.gymId);
  await recordStatusChange(tx, {
    gymId: args.gymId,
    userMembershipId: Number(row.id),
    memberId: Number(row.member_id),
    previousStatus: row.status,
    newStatus: 'active',
    source: args.actor.source,
    actorUserId: args.actor.actorUserId,
  });
  return {
    kind: 'activated',
    superseded: conflicts.map((c) => c.id),
    previousStatus: row.status,
  };
}

/**
 * Lock a Draft for Save & Pay: `draft -> pending_payment`.
 *
 * Deliberately separate from the commit above rather than a mode of it, because
 * the two are different promises. This one takes no money and cancels nothing —
 * it records that the configuration is now the one being charged for, which is
 * what makes §8's "the operation should not leave the system in a partially
 * committed state" true of an abandoned checkout: the member's current plan is
 * untouched until the money arrives.
 *
 * The caller has already made the provider call, so this runs in the transaction
 * that also writes the `payment_requests` row — the lock and the charge land
 * together or neither does.
 */
export async function lockAssignmentForPayment(
  tx: Tx,
  args: { gymId: string; id: number | string; memberId: number; actor: CommitActor },
): Promise<boolean> {
  const { rowCount } = await tx.query(
    `UPDATE user_memberships SET status = ?
      WHERE id = ? AND gym_id = ? AND status = ?`,
    [PENDING_PAYMENT_ASSIGNMENT_STATUS, args.id, args.gymId, DRAFT_ASSIGNMENT_STATUS],
  );
  if (rowCount === 0) return false;
  await recordStatusChange(tx, {
    gymId: args.gymId,
    userMembershipId: Number(args.id),
    memberId: args.memberId,
    previousStatus: DRAFT_ASSIGNMENT_STATUS,
    newStatus: PENDING_PAYMENT_ASSIGNMENT_STATUS,
    source: args.actor.source,
    actorUserId: args.actor.actorUserId,
  });
  return true;
}
