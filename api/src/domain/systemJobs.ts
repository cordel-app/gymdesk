/**
 * #3471: the system jobs Cordel → Jobs lists, and how each one is started.
 *
 * One entry per job of `JOB_RUN_JOBS` (`domain/jobRuns.ts`, the history's own list):
 * the internal route the scheduler (GitHub Actions, through the admin relay) already
 * calls, the environment variable holding the secret that route compares, and whether
 * a superadmin may start it from the application.
 *
 * A manual run is the scheduled run, started earlier: the API calls the job's own
 * internal route with the server-held secret (`api/system-job-trigger.ts`), so the
 * route's guards (#780's once-per-UTC-day rule, the overlap 429) apply and the run
 * writes its row in the history the scheduler's runs write. Nothing here runs a job.
 *
 * `manual: false` is the one job a button must not start: the nightly billing run
 * charges members' stored cards, and starting it before its scheduled time would
 * charge the day's obligations at an hour nobody chose. It stays the scheduler's
 * (or a `workflow_dispatch` an operator starts deliberately).
 */
import { JOB_RUN_JOBS, type JobRunJob } from './jobRuns';

export interface SystemJob {
  job: JobRunJob;
  /** The internal route the scheduler calls (POST). */
  path: string;
  /** The env variable whose value the route compares with `X-Internal-Secret`. */
  secretEnv: 'BILLING_INTERNAL_SECRET' | 'RECURRING_BOOKINGS_INTERNAL_SECRET' | 'BOOKING_REMINDERS_INTERNAL_SECRET';
  /** Whether the application may start it. */
  manual: boolean;
}

export const SYSTEM_JOBS: readonly SystemJob[] = [
  { job: 'billing_run', path: '/billing/run', secretEnv: 'BILLING_INTERNAL_SECRET', manual: false },
  { job: 'recurring_bookings', path: '/recurring-bookings/run', secretEnv: 'RECURRING_BOOKINGS_INTERNAL_SECRET', manual: true },
  { job: 'billing_cleanup', path: '/billing/cleanup', secretEnv: 'BILLING_INTERNAL_SECRET', manual: true },
  { job: 'promotion_lifecycle', path: '/promotion-lifecycle/run', secretEnv: 'BILLING_INTERNAL_SECRET', manual: true },
  { job: 'plan_allowance_renewals', path: '/plan-allowance-renewals/run', secretEnv: 'BILLING_INTERNAL_SECRET', manual: true },
  { job: 'booking_reminders', path: '/booking-reminders/run', secretEnv: 'BOOKING_REMINDERS_INTERNAL_SECRET', manual: true },
  { job: 'assignment_lifecycle', path: '/assignment-lifecycle/run', secretEnv: 'BILLING_INTERNAL_SECRET', manual: true },
  { job: 'billing_window_maintenance', path: '/billing/maintain-window', secretEnv: 'BILLING_INTERNAL_SECRET', manual: true },
];

export function systemJobOf(job: string): SystemJob | null {
  return SYSTEM_JOBS.find((j) => j.job === job) ?? null;
}

/** Every job in the history's list is registered here, and nothing else. */
export function registryMatchesHistory(): boolean {
  return SYSTEM_JOBS.length === JOB_RUN_JOBS.length
    && JOB_RUN_JOBS.every((j) => SYSTEM_JOBS.some((s) => s.job === j));
}

export type ManualRunRefusal = 'unknown_job' | 'manual_run_not_supported' | 'not_configured';

/** Whether a job may be started now; the secret's presence is the caller's to pass. */
export function manualRunRefusal(job: string, secretConfigured: boolean): ManualRunRefusal | null {
  const entry = systemJobOf(job);
  if (!entry) return 'unknown_job';
  if (!entry.manual) return 'manual_run_not_supported';
  if (!secretConfigured) return 'not_configured';
  return null;
}
