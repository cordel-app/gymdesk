import { Router, Request, Response } from 'express';
import { db } from '../infra/db';
import { SYSTEM_ACTOR } from '../domain/auditActor';
import { cancelAtPeriodEndDueSql } from '../domain/assignmentStatus';
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

/** Moves every due `active_cancel_at_period_end` assignment to `cancelled`; answers how many moved. */
export async function endCancelledAtPeriodEnd(): Promise<number> {
  return db.transaction(async (tx) => {
    const { rows } = await tx.query<{ id: number; gym_id: string; member_id: number; status: string }>(
      `SELECT um.id, um.gym_id, um.member_id, um.status FROM user_memberships um
        WHERE ${cancelAtPeriodEndDueSql('um')} FOR UPDATE`);
    for (const row of rows) {
      await tx.query(
        `UPDATE user_memberships
            SET status = 'cancelled', modified_at = UTC_TIMESTAMP(), modified_by = ?
          WHERE id = ?`,
        [SYSTEM_ACTOR, row.id]);
      await recordStatusChange(tx, {
        gymId: row.gym_id, userMembershipId: row.id, memberId: Number(row.member_id),
        previousStatus: row.status, newStatus: 'cancelled', source: 'system', actorUserId: null,
      });
    }
    return rows.length;
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
