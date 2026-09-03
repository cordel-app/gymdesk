import crypto from 'crypto';
import { Router, Request, Response, NextFunction } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireModuleWrite } from '../infra/tenantContext';
import { getPaymentProvider } from '../payments';
import { parseQuery, z } from '../infra/validate';

export const paymentRequestsRouter = Router();

// Module-level read gate (requireModuleAccess('PAYMENTS')) applied in app.ts

const PR_STATUSES = ['pending', 'completed', 'failed', 'expired'] as const;

paymentRequestsRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  const { gymId } = getTenantContext(req);
  const q = parseQuery(req, res, z.object({
    member_id: z.coerce.number().int().positive().optional(),
    status: z.enum(PR_STATUSES).optional(),
  }));
  if (!q) return;

  try {
    const params: (string | number)[] = [gymId];
    let where = 'WHERE pr.gym_id = ?';
    if (q.member_id !== undefined) { where += ' AND pr.member_id = ?'; params.push(q.member_id); }
    if (q.status) { where += ' AND pr.status = ?'; params.push(q.status); }

    const { rows } = await db.query(
      `SELECT pr.id, pr.user_membership_id, pr.member_id, pr.amount, pr.currency,
              pr.status, pr.provider, pr.provider_order, pr.provider_ref,
              pr.source, pr.initiated_by, pr.created_at, pr.completed_at,
              m.name AS member_name
       FROM payment_requests pr
       JOIN members m ON m.id = pr.member_id
       ${where}
       ORDER BY pr.created_at DESC`,
      params,
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

paymentRequestsRouter.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  const { gymId } = getTenantContext(req);
  try {
    const { rows } = await db.query(
      `SELECT pr.*, m.name AS member_name, m.email AS member_email
       FROM payment_requests pr
       JOIN members m ON m.id = pr.member_id
       WHERE pr.id = ? AND pr.gym_id = ?`,
      [Number(req.params.id), gymId],
    );
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

paymentRequestsRouter.post(
  '/',
  requireModuleWrite('PAYMENTS'),
  async (req: Request, res: Response, next: NextFunction) => {
    const { gymId } = getTenantContext(req);
    const { user_membership_id } = req.body as { user_membership_id?: number };

    if (!user_membership_id) {
      return res.status(400).json({ error: 'user_membership_id is required' });
    }

    try {
      const { rows: umRows } = await db.query<{
        member_id: number;
        final_price: string;
        membership_plan_id: number;
        member_email: string;
        member_name: string;
      }>(
        `SELECT um.member_id, um.final_price, um.membership_plan_id,
                m.email AS member_email, m.name AS member_name
         FROM user_memberships um
         JOIN members m ON m.id = um.member_id
         WHERE um.id = ? AND um.gym_id = ? AND um.status <> 'cancelled'`,
        [user_membership_id, gymId],
      );
      if (!umRows[0]) return res.status(404).json({ error: 'Membership not found' });
      const um = umRows[0];

      const { rows: ctRows } = await db.query<{ id: number }>(
        `SELECT id FROM charge_types WHERE code = 'membership_fee' LIMIT 1`,
      );
      if (!ctRows[0]) return res.status(500).json({ error: 'charge_type membership_fee not configured' });

      const amount = Math.round(parseFloat(um.final_price) * 100);
      const orderId = crypto.randomUUID();
      const pageToken = crypto.randomUUID();
      const pageTokenExpires = new Date(Date.now() + 10 * 60 * 1000);

      req.log.info({ orderId, memberId: um.member_id, amount }, 'Payment request created');

      const provider = getPaymentProvider();
      const result = await provider.createPaymentRequest({
        orderId,
        amount,
        currency: 'EUR',
        description: 'Membership fee',
        memberEmail: um.member_email,
        okUrl: process.env.PAYMENT_OK_URL ?? '',
        koUrl: process.env.PAYMENT_KO_URL ?? '',
        notificationUrl: process.env.PAYMENT_NOTIFICATION_URL ?? '',
      });

      req.log.info({ orderId, providerOrderId: result.providerOrderId }, 'Provider API call succeeded');

      const { insertId } = await db.query(
        `INSERT INTO payment_requests
           (gym_id, user_membership_id, member_id, amount, currency, charge_type_id,
            status, provider, provider_order, provider_ref, page_token, page_token_expires,
            initiated_by, source)
         VALUES (?, ?, ?, ?, 'EUR', ?, 'pending', 'monei', ?, ?, ?, ?, ?, 'admin')`,
        [
          gymId, user_membership_id, um.member_id, um.final_price, ctRows[0].id,
          orderId, result.providerOrderId, pageToken, pageTokenExpires,
          (req as any).auth.userId,
        ],
      );

      const checkoutUrl = `${process.env.PAYMENT_PAGE_URL ?? 'https://pay.vdicube.com'}/checkout?token=${pageToken}`;
      res.status(201).json({ id: insertId, checkoutUrl });
    } catch (err) {
      req.log.error({ err: (err as Error).message }, 'Payment request creation failed');
      next(err);
    }
  },
);
