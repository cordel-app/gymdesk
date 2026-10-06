import { Router, Request, Response } from 'express';
import { db } from '../infra/db';
import { recordNotifications } from '../infra/notifications';
import {
  BOOKING_REMINDER_LEAD_MINUTES,
  BOOKING_REMINDER_MAX_PER_RUN,
  groupRemindersByGym,
  reminderCandidatesParams,
  reminderCandidatesSql,
  type ReminderCandidate,
} from '../domain/bookingReminders';

/**
 * #1113 §2: the scheduled runner that raises the 2-hour training reminder.
 *
 * System-wide, like the other scheduled jobs: it walks every gym's upcoming
 * bookings in one statement and is authenticated by the `X-Internal-Secret`
 * header rather than a Clerk session, which is why it is mounted outside
 * `tenantContext` (`app.ts`). A timer inside the API process would run once per
 * replica; "no new infrastructure" is this codebase's standing answer to that
 * (see `recurring-bookings.ts`), so the trigger is a GitHub Actions workflow —
 * `.github/workflows/booking-reminder-run.yml`.
 *
 * **It gets its own secret.** `promotion-lifecycle.ts` shares
 * `BILLING_INTERNAL_SECRET` precisely because it is a *step of the billing
 * workflow*, and says in as many words that a job with a workflow of its own
 * gets a secret of its own with it — the way
 * `RECURRING_BOOKINGS_INTERNAL_SECRET` belongs to its own workflow. This one
 * runs on its own schedule, several times an hour, so it carries
 * `BOOKING_REMINDERS_INTERNAL_SECRET`. Unset, the route answers `401` and no
 * reminder is ever raised, which is why it is a `docs/go-to-production.md` item
 * rather than an optional extra.
 *
 * **No run log.** `claimRun()`/`finishRun()` (#780) enforce *one completed run
 * per UTC date* for the two runs that move money and book slots; this one is
 * the opposite shape — it must run many times a day, and running it again five
 * minutes later is a no-op by construction, because a reminder already written
 * is what takes a booking out of the candidate set (§5). A date-keyed guard
 * would therefore silence every reminder but the first pass of the day. Two
 * overlapping passes are serialised by nothing and need to be: the worst case
 * is a duplicate row for a booking whose reminder landed between the two
 * `SELECT`s, which is why the cadence is minutes apart rather than seconds and
 * why the insert is awaited (`recordNotifications`) instead of fire-and-forget.
 *
 * **No audit rows.** `recordAudit()` needs `req.tenantCtx` and returns early
 * without it, and there is no actor to attribute this to — the same reason the
 * nightly billing run records its work as `billing_events` rather than audit
 * entries. The alert row itself is the record that the member was told.
 *
 * **No feature-flag check.** A reminder is not a capability a gym opts into: it
 * is about a booking that already exists, made through a calendar the gym had
 * switched on at the time. A gym with no bookings in the window simply has no
 * candidates, which is the same answer a flag would give and one fewer thing
 * that can silently stop a member being told about a training they are
 * expected at.
 */
export const bookingRemindersRouter = Router();

function checkInternalSecret(req: Request, res: Response): boolean {
  const secret = req.headers['x-internal-secret'];
  const expected = process.env.BOOKING_REMINDERS_INTERNAL_SECRET;
  if (!expected || secret !== expected) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

/**
 * POST /booking-reminders/run
 * Raises one `booking_reminder_2h` alert per active booking whose occurrence
 * starts within the next two hours and that has none yet.
 * Auth: X-Internal-Secret header (BOOKING_REMINDERS_INTERNAL_SECRET env var).
 *
 * Answers `{ candidates, created, gyms, lead_minutes, capped }` — the counters
 * the workflow reads (#778's rule: a run that could not do its job has to be
 * visible in the body, because `curl -sf` alone only sees the status).
 * `candidates: 0` is the ordinary answer for most passes and is not a failure.
 * `capped` says the pass hit `BOOKING_REMINDER_MAX_PER_RUN` and the next one has
 * work left, which is information rather than an error.
 */
bookingRemindersRouter.post('/run', async (req: Request, res: Response) => {
  if (!checkInternalSecret(req, res)) return;

  try {
    const { rows } = await db.query(
      reminderCandidatesSql(),
      reminderCandidatesParams(),
    );
    const candidates = rows as ReminderCandidate[];
    const byGym = groupRemindersByGym(candidates);

    let created = 0;
    const failures: { gym_id: string; error: string }[] = [];
    for (const [gymId, notifications] of byGym) {
      // One gym's failure must not cost every other gym's reminders: the alert
      // is per member and there is nothing transactional about a log.
      try {
        created += await recordNotifications(gymId, notifications);
      } catch (err) {
        failures.push({ gym_id: gymId, error: (err as Error).message });
      }
    }

    const body = {
      candidates: candidates.length,
      created,
      gyms: byGym.size,
      lead_minutes: BOOKING_REMINDER_LEAD_MINUTES,
      capped: candidates.length >= BOOKING_REMINDER_MAX_PER_RUN,
      ...(failures.length > 0 ? { failures } : {}),
    };
    req.log.info(body, 'booking reminder run');
    res.json(body);
  } catch (err) {
    req.log.error({ err: (err as Error).message }, 'booking reminder run failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});
