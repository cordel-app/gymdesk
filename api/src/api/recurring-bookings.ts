import { Router, Request, Response } from 'express';
import { db } from '../infra/db';
import { isFeatureEnabled } from '../infra/featureFlags';
import { recordNotifications } from '../infra/notifications';
import {
  SkipNotification,
  planSkipNotifications,
  skipNotificationKey,
} from '../domain/personalTrainingSlots';
import {
  bookSelectedSlots,
  describeSlotRun,
  loadProjection,
  loadSelections,
} from './member-personal-training-slots';

/**
 * #647 stage 4: the rolling 2-month Personal Training booking window.
 *
 *   POST /recurring-bookings/run
 *
 * §4 asks for a task that "continuously maintains a 2-month booking window" for
 * every Member with recurring slots. The issue thread's Q4 answer settles what
 * "task" means here:
 *
 *   > it should be a daily activity at night. System will check how sessions
 *   > are pre-booked and will book whatever needed to maintain 2 months.
 *
 * and Q5 settles what it does about the dates it cannot take:
 *
 *   > What we could do is that the night scheduler when trying to book the new
 *   > calendar_events, can publish an alert into the membership app informing
 *   > that the booking on May 1st could not be completed because it is a
 *   > festivity or the gym is closed or it was already booked by another event.
 *
 * **It is an endpoint, not an in-process scheduler.** `POST /billing/run` is
 * the precedent: the API exposes the run, something external (a cron, a
 * Kubernetes CronJob, a GitHub Action) fires it nightly, and the same
 * X-Internal-Secret header authenticates it. Putting a timer inside the API
 * process would misbehave the moment the API runs more than one replica — each
 * would run its own copy of the job — and "no new infrastructure" is the
 * codebase's standing answer to that question.
 *
 * **The window moves, the work does not accumulate.** Nothing here tracks how
 * far a Member has been booked. Each run re-projects the next two months from
 * *now* and books whatever is free and not already held — so yesterday's run
 * covering up to the 30th and today's covering up to the 1st differ by exactly
 * the dates that have newly come into range. §4's "creates only missing
 * bookings" and "does not create duplicates" therefore fall out of the
 * projection rather than out of bookkeeping that could drift.
 *
 * Every booking rule stays where it was: `bookSelectedSlots()` is the very
 * function `POST /members/:id/personal-training-slots/book` runs, so capacity,
 * waitlist mode, #481 eligibility, package-credit debiting and the §5
 * Professional Service re-check happen exactly once in the codebase.
 */
export const recurringBookingsRouter = Router();

/**
 * Minimum gap between two *full* runs, mirroring `POST /billing/run`'s guard.
 *
 * 23 rather than 24 so a nightly cron whose fire time drifts by a few minutes
 * is never rejected. Unlike billing, a second run would not double-charge
 * anyone — it is idempotent by construction — so this exists to stop two runs
 * overlapping and walking the same members at once, not to protect money.
 */
const MIN_RUN_INTERVAL_HOURS = 23;

/** The flag the Member-facing slot endpoints are mounted behind (see app.ts). */
const FEATURE_KEY = 'organization.professional_services';

/**
 * Notifications are deduped against what the job already told this Member.
 * The lookback only has to cover the window the job can alert about — two
 * months — with room to spare for a run that was paused and resumed.
 */
const NOTIFICATION_LOOKBACK_DAYS = 120;

function checkInternalSecret(req: Request, res: Response): boolean {
  const secret = req.headers['x-internal-secret'];
  const expected = process.env.RECURRING_BOOKINGS_INTERNAL_SECRET;
  if (!expected || secret !== expected) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

/** (gym, member) pairs that have at least one stored weekly pattern. */
interface RunTarget {
  gym_id: string;
  member_id: number;
}

/**
 * Members to walk.
 *
 * Driven by `member_recurring_slots` rather than by `members`: a Member without
 * a stored pattern has nothing to maintain, and on a platform of any size the
 * ones who do are a small minority. Soft-deleted members *and* soft-deleted
 * gyms are excluded, so the job never keeps filling a closed gym's calendar —
 * `member_recurring_slots` cascades on a hard delete, but a soft-deleted gym's
 * rows are all still there.
 *
 * `limit` is a safety valve, not a page size: there is no cursor, so a capped
 * run walks the same first N members every night and never reaches the rest.
 * The nightly run therefore passes none, and an operator who caps a run should
 * expect exactly that prefix.
 */
async function loadRunTargets(
  gymId: string | null,
  memberId: number | null,
  limit: number | null,
): Promise<RunTarget[]> {
  const where: string[] = ['m.deleted_at IS NULL', 'g.deleted_at IS NULL'];
  const params: unknown[] = [];
  if (gymId) {
    where.push('mrs.gym_id = ?');
    params.push(gymId);
  }
  if (memberId) {
    where.push('mrs.member_id = ?');
    params.push(memberId);
  }
  const { rows } = await db.query<RunTarget>(
    `SELECT DISTINCT mrs.gym_id, mrs.member_id
       FROM member_recurring_slots mrs
       JOIN members m ON m.id = mrs.member_id AND m.gym_id = mrs.gym_id
       JOIN gyms g ON g.id = mrs.gym_id
      WHERE ${where.join(' AND ')}
      ORDER BY mrs.gym_id ASC, mrs.member_id ASC
      ${limit === null ? '' : `LIMIT ${limit}`}`,
    params,
  );
  return rows.map((r) => ({ gym_id: String(r.gym_id), member_id: Number(r.member_id) }));
}

/**
 * Alerts this Member has already been sent, as `skipNotificationKey()` values.
 *
 * Read per member rather than per gym: the window is two months of a handful of
 * weekly slots, so this is tens of rows, and keeping it per member means one
 * Member with a long history cannot blow up the run's memory.
 *
 * `member_notifications.created_at` defaults to `CURRENT_TIMESTAMP` (migration
 * 087), i.e. the server's local zone, while the bound below is `UTC_TIMESTAMP()`
 * — deliberately not worth reconciling here. The lookback is only a bound on
 * how far back to read *dedupe keys*; a few hours of skew cannot let an alert
 * through twice, because the window it has to cover is two months and the
 * lookback is 120 days.
 */
async function loadSentNotificationKeys(gymId: string, memberId: number): Promise<Set<string>> {
  const { rows } = await db.query<{ slot_key: string | null; date: string | null }>(
    `SELECT payload ->> '$.slot_key' AS slot_key,
            payload ->> '$.date'     AS date
       FROM member_notifications
      WHERE gym_id = ? AND member_id = ?
        AND type = 'recurring_booking_skipped'
        AND created_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? DAY)`,
    [gymId, memberId, NOTIFICATION_LOOKBACK_DAYS],
  );
  const keys = new Set<string>();
  for (const row of rows) {
    if (row.slot_key && row.date) keys.add(skipNotificationKey(row.slot_key, row.date));
  }
  return keys;
}

/**
 * Write the alerts for one Member.
 *
 * `entity_type`/`entity_id` point at the occurrence when there is one; a
 * `no_occurrence` date has nothing to point at, which is exactly why the
 * payload carries the slot and the date too. `title` is the field
 * `GET /me/notifications` and the member app already expect on every payload.
 */
async function writeSkipNotifications(
  gymId: string,
  memberId: number,
  notifications: SkipNotification[],
): Promise<number> {
  return recordNotifications(
    gymId,
    notifications.map((n) => ({
      memberId,
      type: 'recurring_booking_skipped' as const,
      entityType: n.calendar_event_id != null ? ('event' as const) : null,
      entityId: n.calendar_event_id,
      payload: {
        title: n.activity_type_name ?? n.professional_service_name ?? 'Personal Training',
        date: n.date,
        reason: n.reason,
        slot_key: n.slot_key,
        weekday: n.weekday,
        start_time: n.start_time,
        end_time: n.end_time,
        professional_service_name: n.professional_service_name,
        activity_type_name: n.activity_type_name,
      },
    })),
  );
}

/** What one Member's pass produced, as the run report lists it. */
interface MemberRunReport {
  gym_id: string;
  member_id: number;
  created: number;
  skipped: number;
  failed: number;
  notified: number;
  /** Only present when `detail` was requested — the per-slot, per-date picture. */
  slots?: ReturnType<typeof describeSlotRun>;
  /** Set when the pass itself threw; the run continues with the next Member. */
  error?: string;
}

/**
 * Maintain the window for one Member: project, book what is free, alert on what
 * is not.
 *
 * Exported for the test suite and for any future targeted re-run. Never throws
 * for a reason the caller can do nothing about — the run has to survive one
 * Member's bad data.
 */
export async function runMemberRecurringBookings(
  gymId: string,
  memberId: number,
  detail = false,
): Promise<MemberRunReport> {
  const base = { gym_id: gymId, member_id: memberId, created: 0, skipped: 0, failed: 0, notified: 0 };

  const selections = await loadSelections(gymId, memberId);
  // A Member whose last selection was removed between the target query and here.
  if (selections.length === 0) return base;

  const projection = await loadProjection(gymId, memberId, selections);
  const run = await bookSelectedSlots(gymId, memberId, selections, projection.days);

  const alreadySent = await loadSentNotificationKeys(gymId, memberId);
  const notifications = planSkipNotifications(run.slots, alreadySent);
  const notified = await writeSkipNotifications(gymId, memberId, notifications);

  return {
    ...base,
    created: run.created,
    skipped: run.skipped,
    failed: run.failed,
    notified,
    ...(detail ? { slots: describeSlotRun(run.slots) } : {}),
  };
}

/**
 * POST /recurring-bookings/run
 *
 * Auth: X-Internal-Secret header (RECURRING_BOOKINGS_INTERNAL_SECRET env var).
 * Rate-limited: a full run rejects with 429 if the last one started < 23 h ago.
 *
 * Body (all optional, all for operators rather than the nightly cron):
 *   gym_id     — restrict the run to one gym
 *   member_id  — restrict it to one Member (with or without gym_id)
 *   limit      — cap how many Members are walked (1..10000; default: no cap,
 *                since there is no cursor and a cap would strand the remainder)
 *   detail     — include each Member's per-date report in the response
 *
 * A *scoped* run (gym_id or member_id given) neither checks nor stamps the
 * rate limit: it is a targeted re-run after a fix, and refusing it because the
 * nightly job already ran would make the endpoint useless for the one case an
 * operator reaches for it. Only the unscoped run — the one the cron fires —
 * takes the lock.
 */
recurringBookingsRouter.post('/run', async (req: Request, res: Response) => {
  if (!checkInternalSecret(req, res)) return;

  const body = (req.body ?? {}) as {
    gym_id?: unknown; member_id?: unknown; limit?: unknown; detail?: unknown;
  };

  const gymId = typeof body.gym_id === 'string' && body.gym_id.length > 0 ? body.gym_id : null;
  let memberId: number | null = null;
  if (body.member_id != null) {
    memberId = Number(body.member_id);
    if (!Number.isInteger(memberId) || memberId <= 0) {
      return res.status(400).json({ error: 'member_id must be a positive integer' });
    }
  }
  // No default cap: the job's whole point is that *every* member's window stays
  // two months deep, and `loadRunTargets` has no cursor — a default limit would
  // silently strand everyone past it, night after night, while `processed`
  // still looked healthy.
  let limit: number | null = null;
  if (body.limit != null) {
    limit = Number(body.limit);
    if (!Number.isInteger(limit) || limit <= 0 || limit > 10000) {
      return res.status(400).json({ error: 'limit must be an integer between 1 and 10000' });
    }
  }
  const detail = body.detail === true;
  const scoped = gymId !== null || memberId !== null;

  try {
    // Turning the feature off has to stop the scheduler too, not just the UI —
    // otherwise bookings keep appearing for a feature nobody can see.
    if (!(await isFeatureEnabled(FEATURE_KEY))) {
      return res.status(403).json({ error: 'Feature not available.' });
    }

    if (!scoped) {
      const { rows } = await db.query<{ last_run_at: Date | null }>(
        'SELECT last_run_at FROM recurring_booking_run_log WHERE id = 1',
      );
      const lastRun = rows[0]?.last_run_at;
      if (lastRun) {
        const diffHours = (Date.now() - new Date(lastRun).getTime()) / (1000 * 60 * 60);
        if (diffHours < MIN_RUN_INTERVAL_HOURS) {
          req.log.warn({ lastRun, diffHours }, 'recurring-bookings/run: rate-limited');
          return res.status(429).json({
            error: 'Recurring booking run already executed within the last 23 hours',
          });
        }
      }
      // Stamped at the start, so a run that dies half way still holds the lock.
      await db.query('UPDATE recurring_booking_run_log SET last_run_at = UTC_TIMESTAMP() WHERE id = 1');
    }

    const targets = await loadRunTargets(gymId, memberId, limit);
    req.log.info({ count: targets.length, scoped }, 'recurring-bookings/run: members with recurring slots');

    const members: MemberRunReport[] = [];
    let created = 0;
    let skipped = 0;
    let failed = 0;
    let notified = 0;

    for (const target of targets) {
      try {
        const report = await runMemberRecurringBookings(target.gym_id, target.member_id, detail);
        created += report.created;
        skipped += report.skipped;
        failed += report.failed;
        notified += report.notified;
        members.push(report);
      } catch (err) {
        // One Member's failure must not end the night's run — the next one may
        // be perfectly bookable, and a half-finished window is worse than a
        // reported one.
        const message = err instanceof Error ? err.message : String(err);
        req.log.error({ err, ...target }, 'recurring-bookings/run: member pass failed');
        members.push({ ...target, created: 0, skipped: 0, failed: 0, notified: 0, error: message });
      }
    }

    res.json({
      processed: targets.length,
      created,
      skipped,
      failed,
      notified,
      members,
    });
  } catch (err) {
    req.log.error({ err }, 'recurring-bookings/run: failed');
    res.status(500).json({ error: 'Recurring booking run failed' });
  }
});
