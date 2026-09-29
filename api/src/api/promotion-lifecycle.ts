import { Router, Request, Response } from 'express';
import { db } from '../infra/db';
import { promotionExpiryWhereSql } from '../domain/promotionLifecycle';

/**
 * #900: the scheduled sweep that moves a Promotion past its End Date to
 * `expired`.
 *
 * System-wide, like the other scheduled jobs: it walks every gym's Promotions in
 * one statement and is authenticated by the `X-Internal-Secret` header rather
 * than a Clerk session, which is why it is mounted outside `tenantContext`
 * (`app.ts`) instead of living on the tenant-scoped `/promotions` router. A
 * timer inside the API process would run once per replica; "no new
 * infrastructure" is this codebase's standing answer to that (see
 * `recurring-bookings.ts`), so the trigger is the same GitHub Actions workflow
 * that already calls `POST /billing/run` and `POST /billing/cleanup`.
 *
 * **It shares `BILLING_INTERNAL_SECRET` deliberately.** The secret identifies
 * *the scheduler*, and this sweep is a step of the workflow that already sends
 * that one (`.github/workflows/billing-run.yml`). A third secret would be a
 * third thing to provision and rotate (#783 documents the rotation of the two
 * that exist) for an endpoint that returns no data and whose worst case is a
 * status sweep somebody else's clock already asked for. If this job ever gets a
 * workflow of its own it gets a secret of its own with it, the way
 * `RECURRING_BOOKINGS_INTERNAL_SECRET` belongs to its own workflow.
 *
 * **No run log.** `claimRun()`/`finishRun()` (#780) exist because the billing
 * and recurring-booking runs must not overlap and must run once a day; this one
 * is a single idempotent `UPDATE` with no provider call, no money and no
 * per-member work, so a second run the same day is a no-op by construction
 * (§2) and a concurrent one is serialised by the row locks of that statement.
 * Reporting `expired` as a counter is what the workflow reads, the same way
 * `POST /billing/cleanup` reports its own.
 *
 * **No audit rows.** `recordAudit()` needs `req.tenantCtx` and returns early
 * without it, and there is no system actor to attribute this to — the same
 * reason the nightly billing run records its work as `billing_events` rather
 * than audit entries. The run's own log line carries the count, and each
 * Promotion's `ends_at` is the explanation of why it moved.
 */
export const promotionLifecycleRouter = Router();

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
 * POST /promotion-lifecycle/run
 * Expires every `active` Promotion whose End Date has passed.
 * Auth: X-Internal-Secret header (BILLING_INTERNAL_SECRET env var).
 *
 * Only `lifecycle_status` is written (§8): the dates, the Billing & Duration
 * months, the benefit sections, the targeted Membership Plans and every
 * `user_membership_promotions` application a member already carries are
 * untouched — an application's own snapshot is what prices it (#635 §16), so a
 * Promotion expiring changes nothing about the assignments already on it. What
 * it does change is what new assignments may be given: every apply path
 * requires `lifecycle_status = 'active'`, so an expired Promotion is refused
 * there (§7) exactly as an inactive one is.
 */
promotionLifecycleRouter.post('/run', async (req: Request, res: Response) => {
  if (!checkInternalSecret(req, res)) return;

  try {
    const { rowCount: expired } = await db.query(
      `UPDATE promotions p
          SET p.lifecycle_status = 'expired'
        WHERE ${promotionExpiryWhereSql('p')}`,
    );

    req.log.info({ expired }, 'promotion lifecycle sweep: expired promotions past their end date');
    res.json({ expired });
  } catch (err) {
    req.log.error({ err: (err as Error).message }, 'promotion lifecycle sweep failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});
