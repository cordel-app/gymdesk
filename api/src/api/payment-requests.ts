import { Router, Request, Response, NextFunction } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireModuleWrite } from '../infra/tenantContext';
import { parseQuery, z } from '../infra/validate';
import { currentMembershipFee } from './membership-fee-pricing';
import { CARD_UPDATE_SOURCE } from '../domain/storedCards';
import {
  createMembershipFeeProviderOrder,
  insertMembershipFeePaymentRequest,
  membershipFeeChargeTypeId,
} from './membership-fee-payment-request';

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
    // #788: card verifications carry no money and no charge type — they are read
    // through GET /payment-methods, not as a 0.00 payment in this list.
    const params: (string | number)[] = [gymId, CARD_UPDATE_SOURCE];
    let where = 'WHERE pr.gym_id = ? AND pr.source <> ?';
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
      // Excluded here too, not only from the list: a card verification reachable
      // by id would render in the staff transaction detail view as a 0.00
      // payment with no charge type.
      `SELECT pr.*, m.name AS member_name, m.email AS member_email
       FROM payment_requests pr
       JOIN members m ON m.id = pr.member_id
       WHERE pr.id = ? AND pr.gym_id = ? AND pr.source <> ?`,
      [Number(req.params.id), gymId, CARD_UPDATE_SOURCE],
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
        membership_plan_id: number;
        member_email: string;
        member_name: string;
      }>(
        `SELECT um.member_id, um.membership_plan_id,
                m.email AS member_email, m.name AS member_name
         FROM user_memberships um
         JOIN members m ON m.id = um.member_id
         WHERE um.id = ? AND um.gym_id = ? AND um.status <> 'cancelled'`,
        [user_membership_id, gymId],
      );
      if (!umRows[0]) return res.status(404).json({ error: 'Membership not found' });
      const um = umRows[0];

      // #635 stage 15 — what to ask for is the Membership Fee resolved on the
      // cycle this assignment is next charged for, not a stored number: a
      // request raised during a Free Period, or after an applied Promotion's
      // timeline has ended, has to ask for what the nightly run would take.
      const fee = await currentMembershipFee(gymId, Number(user_membership_id));
      if (fee == null) return res.status(404).json({ error: 'Membership not found' });
      if (!(fee > 0)) {
        return res.status(400).json({ error: 'This membership owes nothing for its current billing cycle' });
      }

      // #1108 stage 2: the charge type, the provider call and the
      // `payment_requests` row are `membership-fee-payment-request.ts`' now —
      // Save & Pay raises the same payment, and three copies of it is how the
      // three come to tell the provider three different things.
      const chargeTypeId = await membershipFeeChargeTypeId();
      if (chargeTypeId == null) {
        return res.status(500).json({ error: 'charge_type membership_fee not configured' });
      }

      const order = await createMembershipFeeProviderOrder({ fee, memberEmail: um.member_email });
      req.log.info(
        { orderId: order.orderId, providerOrderId: order.providerOrderId, memberId: um.member_id },
        'Payment request created',
      );

      const { id, checkoutUrl } = await insertMembershipFeePaymentRequest(db, {
        gymId, userMembershipId: Number(user_membership_id), memberId: um.member_id,
        fee, chargeTypeId, order,
        initiator: { kind: 'staff', userId: (req as any).auth.userId },
      });
      res.status(201).json({ id, checkoutUrl });
    } catch (err) {
      req.log.error({ err: (err as Error).message }, 'Payment request creation failed');
      next(err);
    }
  },
);
