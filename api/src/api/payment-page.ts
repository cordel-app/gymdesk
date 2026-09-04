import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { db } from '../infra/db';

export const paymentPageRouter = Router();

const tokenRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ error: 'Too many requests' }),
});

/**
 * Used exclusively by the isolated payment page app (pay.vdicube.com).
 * Looks up a payment request by its single-use page_token, marks it consumed,
 * and returns display-only fields plus the Monei paymentId the iframe needs.
 * Gymdesk internal IDs are not returned.
 */
paymentPageRouter.get('/token/:token', tokenRateLimit as any, async (req: Request, res: Response) => {
  const { token } = req.params;
  try {
    const row = await db.transaction(async (tx) => {
      // FOR UPDATE serializes concurrent requests on the same token so only
      // one caller can consume it — the loser sees no row after the winner commits.
      const { rows } = await tx.query(
        `SELECT pr.id, pr.amount, pr.currency, pr.provider_ref,
                g.name AS gym_name,
                m.name AS member_name,
                bp.recurring_billing_interval,
                bp.recurring_billing_unit
         FROM payment_requests pr
         JOIN gyms g ON g.id = pr.gym_id
         JOIN members m ON m.id = pr.member_id
         JOIN user_memberships um ON um.id = pr.user_membership_id
         LEFT JOIN billing_policies bp
           ON bp.membership_plan_id = um.membership_plan_id AND bp.gym_id = um.gym_id
         WHERE pr.page_token = ?
           AND pr.page_token_expires > UTC_TIMESTAMP()
           AND pr.status = 'pending'
         FOR UPDATE`,
        [token],
      );

      if (!rows[0] || !rows[0].provider_ref) return null;

      await tx.query(
        `UPDATE payment_requests SET page_token = NULL WHERE id = ?`,
        [rows[0].id],
      );

      return rows[0];
    });

    if (!row) {
      return res.status(404).json({ error: 'Token not found or expired' });
    }

    const billingInterval =
      row.recurring_billing_interval != null && row.recurring_billing_unit != null
        ? `${row.recurring_billing_interval} ${row.recurring_billing_unit}`
        : null;

    res.json({
      paymentId: row.provider_ref,
      amount: Number(row.amount),
      currency: row.currency,
      gymName: row.gym_name,
      memberName: row.member_name,
      billingInterval,
      okUrl: process.env.PAYMENT_OK_URL ?? '',
      koUrl: process.env.PAYMENT_KO_URL ?? '',
    });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});
