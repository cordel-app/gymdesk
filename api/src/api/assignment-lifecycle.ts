import { Router, Request, Response } from 'express';
import { db } from '../infra/db';
import { SYSTEM_ACTOR } from '../domain/auditActor';
import { CANCELS_AT_PERIOD_END_STATUS, cancelAtPeriodEndDueSql } from '../domain/assignmentStatus';
import { isCurrentAssignmentSnapshotSql } from '../domain/planAssignments';
import { finishJobRun, startJobRun } from '../infra/job-run-log';
import { recordStatusChange } from './billing-events';

/**
 * #2659 stage 2: the scheduled sweep that ends a plan cancelled at its period
 * end. An assignment in `active_cancel_at_period_end` whose `ends_at` (the last
 * paid day, #1196) has passed becomes `cancelled`.
 *
 * The promotion-lifecycle sweep's shape (#900) and its reasons: system-wide,
 * mounted outside `tenantContext`, authenticated by `BILLING_INTERNAL_SECRET`
 * because it is a step of `.github/workflows/billing-run.yml`, no run-log claim
 * (a moved row no longer matches, so a second run is a no-op), history in
 * `job_run_log`. Unlike that sweep it writes one `status_change` audit row per
 * moved assignment, in the same transaction, because a membership status
 * transition is an audit row whichever path made it (#1325 PR 3, A4).
 *
 * Nothing is billed or deleted: the plan's future obligations were removed by
 * the cancellation (`retireProjected()`), and access already ended on its own
 * at `ends_at` (`entitledAssignmentSql()` checks the date), so this sweep only
 * makes the stored status say so.
 */
export const assignmentLifecycleRouter = Router();

function checkInternalSecret(req: Request, res: Response): boolean {
  const secret = req.headers['x-internal-secret'];
  const expected = process.env.BILLING_INTERNAL_SECRET;
  if (!expected || secret !== expected) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

/**
 * Moves every due `active_cancel_at_period_end` assignment to `cancelled`; answers how many moved.
 *
 * #2125 M6b-47: the due assignments are picked from `plan_snapshots` (each assignment's current
 * snapshot, `isCurrentAssignmentSnapshotSql()`), never from `user_memberships`. The legacy row is
 * still dual-written, by an UPDATE guarded on the status it is moving away from, so a row another
 * writer moved in between is left alone and gets no second audit row; `recordStatusChange()`
 * re-syncs the snapshot.
 */
export async function endCancelledAtPeriodEnd(): Promise<number> {
  return db.transaction(async (tx) => {
    const { rows } = await tx.query<{ id: number; gym_id: string; member_id: number; status: string }>(
      `SELECT pa.source_user_membership_id AS id, pa.gym_id, pa.member_id, pa.status FROM plan_snapshots pa
        WHERE ${cancelAtPeriodEndDueSql('pa')} AND pa.source_user_membership_id IS NOT NULL
          AND ${isCurrentAssignmentSnapshotSql('pa')}
        ORDER BY pa.source_user_membership_id`);
    let moved = 0;
    for (const row of rows) {
      const { rowCount } = await tx.query(
        `UPDATE user_memberships
            SET status = 'cancelled', modified_at = UTC_TIMESTAMP(), modified_by = ?
          WHERE id = ? AND gym_id = ? AND status = ?`,
        [SYSTEM_ACTOR, row.id, row.gym_id, CANCELS_AT_PERIOD_END_STATUS]);
      if (rowCount === 0) continue;
      await recordStatusChange(tx, {
        gymId: row.gym_id, userMembershipId: Number(row.id), memberId: Number(row.member_id),
        previousStatus: row.status, newStatus: 'cancelled', source: 'system', actorUserId: null,
      });
      moved += 1;
    }
    return moved;
  });
}

/**
 * POST /assignment-lifecycle/run
 * Auth: X-Internal-Secret header (BILLING_INTERNAL_SECRET env var).
 * Answers `{ cancelled }`, the counter the workflow reads.
 */
assignmentLifecycleRouter.post('/run', async (req: Request, res: Response) => {
  if (!checkInternalSecret(req, res)) return;

  const jobRunId = await startJobRun('assignment_lifecycle');
  try {
    const cancelled = await endCancelledAtPeriodEnd();
    req.log.info({ cancelled }, 'assignment lifecycle sweep: plans past their cancellation end date');
    await finishJobRun(jobRunId, 'completed', { httpStatus: 200, details: { cancelled } });
    res.json({ cancelled });
  } catch (err) {
    await finishJobRun(jobRunId, 'failed', { httpStatus: 500, error: err });
    req.log.error({ err: (err as Error).message }, 'assignment lifecycle sweep failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});
