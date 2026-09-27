import { Router, Request, Response } from 'express';
import { lastCompletedRun } from '../infra/run-log';
import { evaluateRunFreshness, runFreshnessThresholdHours } from '../domain/runFreshness';

/**
 * #782: run freshness for an external prober.
 *
 *   GET /health/runs
 *   → 200 { billing: { last_completed_at, age_hours, stale },
 *           recurring_bookings: { last_completed_at, age_hours, stale } }
 *   → 503 { error } when the database cannot be read
 *
 * **Unauthenticated on purpose** (issue thread, Q2): it tells a caller one
 * timestamp per internal job and nothing tenant-scoped — no counters, no gym,
 * no member — and an authenticated probe would mean handing
 * `BILLING_INTERNAL_SECRET` to a Grafana synthetic check.
 *
 * **Outside `/billing/` on purpose**: nginx restricts `location /billing/` to
 * GitHub Actions' IP ranges (`infra/nginx/corback.conf`), which would 403 a
 * Grafana Cloud prober. `/health/runs` is served by `location /`.
 *
 * A stale answer is still a 200: the prober asserts on `stale`, so the status
 * code is kept for "the API could not answer the question at all".
 */
export const healthRouter = Router();

healthRouter.get('/runs', async (req: Request, res: Response) => {
  try {
    const [billing, recurring] = await Promise.all([
      lastCompletedRun('billing_run_log'),
      lastCompletedRun('recurring_booking_run_log'),
    ]);
    const now = new Date();
    const threshold = runFreshnessThresholdHours();
    return res.json({
      billing: evaluateRunFreshness(toDate(billing?.finished_at), now, threshold),
      recurring_bookings: evaluateRunFreshness(toDate(recurring?.finished_at), now, threshold),
    });
  } catch (err) {
    req.log.error({ err: (err as Error).message }, 'health/runs: could not read the run logs');
    return res.status(503).json({ error: 'Run logs unavailable' });
  }
});

/** `finished_at` is a DATETIME read with `timezone: 'Z'`, i.e. UTC. */
function toDate(value: Date | string | null | undefined): Date | null {
  if (value == null) return null;
  return value instanceof Date ? value : new Date(`${value.replace(' ', 'T')}Z`);
}
