import { Tx } from '../infra/db';
import { recordStatusChange } from './billing-events';
import { rollStaleNextBillingDateForward } from '../domain/nextBillingDateStamp';
import { LiveAssignment, supersedeStartsAtError } from '../domain/oneActivePlan';
import { findLiveAssignmentsForMembers, supersedeLiveAssignments } from './one-active-plan';
import { importAssignmentAsProductSet } from './product-set-bridge';

/**
 * #1108 — the one place an assignment is **committed**.
 *
 * Stage 1 put the `draft → active` transition in `POST /user-memberships/:id/activate`;
 * stage 2 adds the state between the two and three more callers of the same
 * commit, so the transition lives here and every caller runs the very same
 * steps under the very same lock:
 *
 *   - `POST /:id/save-and-pay`   draft → pending_payment  (`submitForPayment`,
 *                                 the point of no return: the configuration is
 *                                 locked and the payment is collected around it)
 *   - the payment webhook        pending_payment → active (card: the provider
 *                                 confirmed the money)
 *   - `POST /:id/record-payment` pending_payment → active (cash: the staff did)
 *   - `POST /:id/activate`       draft → active           (no payment to wait
 *                                 for — a free plan, or a staff shortcut)
 *
 * #956's one-plan rule is enforced on **both** moves out of Draft: Save & Pay
 * asks it (and answers the 409 the replacement dialog is drawn from) so the
 * staff member confirms the replacement *before* the member is asked to pay,
 * and the activation supersedes whatever is still live then with that
 * confirmation taken as given — the money has arrived, and a plan that cannot
 * become the member's would leave them paid-up and planless. Nothing is
 * superseded at Save & Pay time: a payment that never arrives must leave the
 * member's current plan exactly as it was.
 */

export const PENDING_PAYMENT_STATUS = 'pending_payment';
export const DRAFT_STATUS = 'draft';

interface CommitInput {
  gymId: string;
  userMembershipId: number | string;
  /** The statuses the row may be in for this move; anything else is `not_committable`. */
  fromStatuses: readonly string[];
  /** `true` supersedes the member's live plans; `false` answers `conflict` instead. */
  confirm: boolean;
  source: string;
  actorUserId: string | null;
}

export type CommitOutcome =
  | { kind: 'not_found' }
  | { kind: 'not_committable'; status: string }
  | { kind: 'conflict'; conflicts: LiveAssignment[] }
  | { kind: 'pending_conflict'; pendingIds: number[] }
  | { kind: 'bad_date'; message: string }
  | { kind: 'committed'; previousStatus: string; memberId: number; superseded: number[] };

async function lockAssignment(tx: Tx, gymId: string, id: number | string) {
  const { rows } = await tx.query<{ id: number; member_id: number; status: string; starts_at: string }>(
    `SELECT id, member_id, status, DATE_FORMAT(starts_at, '%Y-%m-%d') AS starts_at
       FROM user_memberships WHERE id = ? AND gym_id = ? FOR UPDATE`,
    [id, gymId],
  );
  return rows[0] ?? null;
}

/**
 * The live plans of **every Member this assignment covers** (#956 Q4), the
 * assignment itself excluded — it is not live, so it never conflicts with
 * itself. The owner is unioned in because a row written before #374's
 * covered-member table may carry no `user_membership_members` row at all.
 */
async function coveredMemberIds(tx: Tx, gymId: string, row: { id: number; member_id: number }): Promise<number[]> {
  const { rows: coveredRows } = await tx.query<{ member_id: number }>(
    `SELECT member_id FROM user_membership_members WHERE user_membership_id = ? AND gym_id = ?`,
    [row.id, gymId],
  );
  return [...new Set([Number(row.member_id), ...coveredRows.map((r) => Number(r.member_id))])];
}

async function liveConflicts(tx: Tx, gymId: string, row: { id: number; member_id: number }): Promise<LiveAssignment[]> {
  return findLiveAssignmentsForMembers(tx, gymId, await coveredMemberIds(tx, gymId, row), { excludeUserMembershipId: Number(row.id) });
}

/**
 * A **pending** row of another assignment covering one of the same members is
 * a conflict of its own kind: it is never superseded (it is not live), but a
 * second plan committed beside it would meet, at its own activation, a
 * conflict nobody confirmed — so the second commit is refused outright until
 * the pending one is paid or discarded.
 */
async function pendingConflicts(tx: Tx, gymId: string, row: { id: number; member_id: number }): Promise<number[]> {
  const ids = await coveredMemberIds(tx, gymId, row);
  const marks = ids.map(() => '?').join(',');
  const { rows } = await tx.query<{ id: number }>(
    `SELECT DISTINCT um.id
       FROM user_memberships um
       LEFT JOIN user_membership_members umm ON umm.user_membership_id = um.id AND umm.gym_id = um.gym_id
      WHERE um.gym_id = ? AND um.status = ? AND um.id <> ?
        AND (um.member_id IN (${marks}) OR umm.member_id IN (${marks}))
      FOR UPDATE`,
    [gymId, PENDING_PAYMENT_STATUS, row.id, ...ids, ...ids],
  );
  return rows.map((r) => Number(r.id));
}

/** `draft → active` or `pending_payment → active`, superseding on `confirm`. */
export async function commitAssignment(tx: Tx, input: CommitInput): Promise<CommitOutcome> {
  const row = await lockAssignment(tx, input.gymId, input.userMembershipId);
  if (!row) return { kind: 'not_found' };
  if (!input.fromStatuses.includes(row.status)) return { kind: 'not_committable', status: row.status };

  const pending = await pendingConflicts(tx, input.gymId, row);
  if (pending.length > 0) return { kind: 'pending_conflict', pendingIds: pending };

  const conflicts = await liveConflicts(tx, input.gymId, row);
  if (conflicts.length > 0) {
    if (!input.confirm) return { kind: 'conflict', conflicts };
    const dateError = supersedeStartsAtError(row.starts_at, conflicts);
    if (dateError) return { kind: 'bad_date', message: dateError };
    await supersedeLiveAssignments(tx, {
      gymId: input.gymId, conflicts, newStartsAt: row.starts_at,
      source: input.source, actorUserId: input.actorUserId,
    });
  }

  const { rowCount } = await tx.query(
    `UPDATE user_memberships
        SET status = 'active'
      WHERE id = ? AND gym_id = ? AND status = ?`,
    [row.id, input.gymId, row.status],
  );
  if (rowCount === 0) return { kind: 'not_committable', status: row.status };
  // #790: an assignment joining the run's schedule is never put on a cycle
  // that has already gone by. A pre-activation row carries no
  // `next_billing_date` — the first payment stamps it — so this is a no-op
  // today and the one place that answers it either way.
  await rollStaleNextBillingDateForward(tx, Number(row.id), input.gymId);
  await recordStatusChange(tx, {
    gymId: input.gymId, userMembershipId: Number(row.id), memberId: Number(row.member_id),
    previousStatus: row.status, newStatus: 'active',
    source: input.source, actorUserId: input.actorUserId,
  });
  // #1325 PR 3: the committed assignment is handed over to a ProductSet version
  // in this same transaction — from here its obligations are the set's
  // persisted events, which the nightly run executes.
  await importAssignmentAsProductSet(tx, input.gymId, Number(row.id));
  return { kind: 'committed', previousStatus: row.status, memberId: Number(row.member_id), superseded: conflicts.map((c) => c.id) };
}

export type SubmitOutcome =
  | { kind: 'not_found' }
  | { kind: 'not_committable'; status: string }
  | { kind: 'conflict'; conflicts: LiveAssignment[] }
  | { kind: 'pending_conflict'; pendingIds: number[] }
  | { kind: 'bad_date'; message: string }
  | { kind: 'submitted'; memberId: number };

/**
 * `draft → pending_payment` — Save & Pay's half. The one-plan rule is asked
 * here so the replacement is confirmed before the member pays, but nothing is
 * superseded yet: that is the activation's, once the money has arrived.
 */
export async function submitForPayment(tx: Tx, input: Omit<CommitInput, 'fromStatuses'>): Promise<SubmitOutcome> {
  const row = await lockAssignment(tx, input.gymId, input.userMembershipId);
  if (!row) return { kind: 'not_found' };
  if (row.status !== DRAFT_STATUS) return { kind: 'not_committable', status: row.status };

  const pending = await pendingConflicts(tx, input.gymId, row);
  if (pending.length > 0) return { kind: 'pending_conflict', pendingIds: pending };

  const conflicts = await liveConflicts(tx, input.gymId, row);
  if (conflicts.length > 0) {
    if (!input.confirm) return { kind: 'conflict', conflicts };
    const dateError = supersedeStartsAtError(row.starts_at, conflicts);
    if (dateError) return { kind: 'bad_date', message: dateError };
  }

  const { rowCount } = await tx.query(
    `UPDATE user_memberships SET status = ? WHERE id = ? AND gym_id = ? AND status = ?`,
    [PENDING_PAYMENT_STATUS, row.id, input.gymId, DRAFT_STATUS],
  );
  if (rowCount === 0) return { kind: 'not_committable', status: row.status };
  await recordStatusChange(tx, {
    gymId: input.gymId, userMembershipId: Number(row.id), memberId: Number(row.member_id),
    previousStatus: DRAFT_STATUS, newStatus: PENDING_PAYMENT_STATUS,
    source: input.source, actorUserId: input.actorUserId,
  });
  // #1325 PR 3b: the Pending Payment version exists from here, with its initial
  // Billing Event, so every payment raised for this row is an attempt on it.
  await importAssignmentAsProductSet(tx, input.gymId, Number(row.id), { pending: true });
  return { kind: 'submitted', memberId: Number(row.member_id) };
}
