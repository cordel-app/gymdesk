import { renewalDatesThrough, type SessionBenefitFrequency } from './sessionBenefitFrequency';

/**
 * #1227 stage 2: the renewal of a Membership Plan's Session Benefit allowance.
 *
 * A Session Benefit with a renewing Frequency (#918: `2 | Weekly`) includes its
 * quantity again on every renewal. The entitlement is the **Assigned Plan
 * snapshot's** line (`user_membership_session`, #635 §13–§17), never the live
 * Plan, and each renewal is one append-only row of `plan_allowance_renewals`
 * (migration 244): the row is both the grant that raises the balance and the
 * history entry staff read, so there is no second record of what was renewed.
 *
 * Idempotency is the database's — `UNIQUE (user_membership_session_id,
 * renewal_date)` — so a repeated or concurrent run adds nothing. Pure; the SQL
 * half is `api/plan-allowance-renewals.ts`.
 */

/**
 * How far back the very first run for a line looks. A line with no renewal row
 * yet is either brand new or older than this ticket; granting every renewal
 * since an old `starts_at` would hand members months of sessions retroactively,
 * so only the last week is caught up. Once a line has a row the next run
 * continues from it, however long the gap.
 */
export const FIRST_RUN_CATCH_UP_DAYS = 7;

export interface RenewalLine {
  /** `user_membership_session.id`. */
  line_id: number;
  /** Assignment `starts_at`, `YYYY-MM-DD`. */
  starts_at: string;
  /** Assignment `ends_at`, `YYYY-MM-DD`, or null for open-ended. */
  ends_at: string | null;
  frequency: SessionBenefitFrequency | null;
  quantity: number;
  /** Latest renewal already written for this line, or null. */
  last_renewal_date: string | null;
}

export interface DueRenewal {
  line_id: number;
  renewal_date: string;
  quantity: number;
}

/** `YYYY-MM-DD` minus whole days, in UTC. */
export function minusDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/** The renewals a line is owed as of `today` (`YYYY-MM-DD`) that are not yet written. */
export function dueRenewals(line: RenewalLine, today: string): DueRenewal[] {
  const quantity = Number(line.quantity);
  if (!Number.isInteger(quantity) || quantity <= 0) return [];
  const through = line.ends_at && line.ends_at < today ? line.ends_at : today;
  const after = line.last_renewal_date ?? minusDays(today, FIRST_RUN_CATCH_UP_DAYS);
  return renewalDatesThrough(line.starts_at, after, through, line.frequency).map((renewal_date) => ({
    line_id: line.line_id,
    renewal_date,
    quantity,
  }));
}
