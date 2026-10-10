import { Router, Request, Response } from 'express';
import { db } from '../infra/db';
import { dueRenewals, type RenewalLine } from '../domain/planAllowanceRenewals';
import { toSessionBenefitFrequency } from '../domain/sessionBenefitFrequency';

/**
 * #1227 stage 2: the nightly renewal of Membership Plan Session Benefit
 * allowances (`domain/planAllowanceRenewals.ts` decides what is owed; this is
 * the SQL half and the trigger).
 *
 * System-wide and authenticated by `X-Internal-Secret`, like
 * `promotion-lifecycle.ts`, and for the same reasons it shares
 * `BILLING_INTERNAL_SECRET` (it is a step of `billing-run.yml`) and claims **no
 * run-log slot**: every insert is `INSERT IGNORE` under
 * `UNIQUE (user_membership_session_id, renewal_date)`, so a second run the same
 * day, the 10:00 UTC safety net or an overlapping pair writes nothing twice.
 * No audit rows (no tenant actor); the renewal rows are the record.
 */
export const planAllowanceRenewalsRouter = Router();

function checkInternalSecret(req: Request, res: Response): boolean {
  const secret = req.headers['x-internal-secret'];
  const expected = process.env.BILLING_INTERNAL_SECRET;
  if (!expected || secret !== expected) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

/** Writes every renewal owed as of `today`; returns the counters the workflow reads. */
export async function runPlanAllowanceRenewals(today: string): Promise<{ lines: number; renewed: number }> {
  // Only an `active` assignment renews (the plan_session grant itself needs
  // `active`); a renewing frequency is the only line that can be owed one.
  const { rows } = await db.query(
    `SELECT umss.id AS line_id, umss.gym_id, umss.quantity, umss.frequency,
            DATE_FORMAT(um.starts_at, '%Y-%m-%d') AS starts_at,
            DATE_FORMAT(um.ends_at, '%Y-%m-%d')   AS ends_at,
            (SELECT DATE_FORMAT(MAX(par.renewal_date), '%Y-%m-%d')
               FROM plan_allowance_renewals par
              WHERE par.user_membership_session_id = umss.id) AS last_renewal_date
       FROM user_membership_session umss
       JOIN user_memberships um ON um.id = umss.user_membership_id AND um.gym_id = umss.gym_id
      WHERE um.status = 'active'
        AND umss.frequency IS NOT NULL AND umss.frequency <> 'once'
        AND umss.quantity > 0
        AND um.starts_at <= ?`,
    [today],
  );

  let renewed = 0;
  for (const r of rows as Array<Record<string, any>>) {
    const line: RenewalLine = {
      line_id: Number(r.line_id),
      starts_at: r.starts_at,
      ends_at: r.ends_at ?? null,
      frequency: toSessionBenefitFrequency(r.frequency),
      quantity: Number(r.quantity),
      last_renewal_date: r.last_renewal_date ?? null,
    };
    for (const due of dueRenewals(line, today)) {
      const { rowCount } = await db.query(
        `INSERT IGNORE INTO plan_allowance_renewals
           (gym_id, user_membership_session_id, renewal_date, quantity)
         VALUES (?, ?, ?, ?)`,
        [r.gym_id, due.line_id, due.renewal_date, due.quantity],
      );
      renewed += rowCount ?? 0;
    }
  }
  return { lines: rows.length, renewed };
}

/**
 * POST /plan-allowance-renewals/run
 * Auth: X-Internal-Secret header (BILLING_INTERNAL_SECRET env var).
 */
planAllowanceRenewalsRouter.post('/run', async (req: Request, res: Response) => {
  if (!checkInternalSecret(req, res)) return;
  try {
    const { rows } = await db.query<{ today: string }>("SELECT DATE_FORMAT(UTC_DATE(), '%Y-%m-%d') AS today");
    const result = await runPlanAllowanceRenewals(rows[0].today);
    req.log.info(result, 'plan allowance renewals');
    res.json(result);
  } catch (err) {
    req.log.error({ err: (err as Error).message }, 'plan allowance renewals failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});
