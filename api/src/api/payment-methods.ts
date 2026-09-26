import { Router, Request, Response, NextFunction } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireModuleWrite } from '../infra/tenantContext';
import { parseBody, parseQuery, z } from '../infra/validate';
import {
  createCardUpdateRequest,
  loadCardRemovalBlock,
  loadStoredCard,
  resolveCardUpdateMembership,
} from './card-updates';

/**
 * #788: the staff side of a member's stored card. Read-only — no route here
 * accepts card data, so the PCI scope stays on the isolated payment page — plus
 * the one action the staff needs: raise the same card-replacement link the
 * member would raise themselves and hand it over, exactly as the Payments modal
 * already hands over a payment link.
 *
 * Module-level read gate (requireModuleAccess('PAYMENTS')) applied in app.ts.
 */
export const paymentMethodsRouter = Router();

/** The card on file for one member, without the token that charges it. */
paymentMethodsRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  const { gymId } = getTenantContext(req);
  const q = parseQuery(req, res, z.object({
    member_id: z.coerce.number().int().positive(),
  }));
  if (!q) return;

  try {
    // Tenant scope is the member row, not the payment_methods row: a member id
    // from another gym answers 404 rather than an empty card.
    const { rows: memberRows } = await db.query<{ id: number }>(
      'SELECT id FROM members WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
      [q.member_id, gymId],
    );
    if (!memberRows[0]) return res.status(404).json({ error: 'Member not found' });

    const [payment_method, removalBlock] = await Promise.all([
      loadStoredCard(gymId, q.member_id),
      loadCardRemovalBlock(gymId, q.member_id),
    ]);

    res.json({
      payment_method,
      /** Mirrors what `DELETE /me/payment-method` would answer the member. */
      member_can_remove: payment_method != null && removalBlock == null,
      removal_blocked_reason: payment_method != null ? removalBlock : null,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Raises a card-replacement link for a member. The member still enters the card
 * on the isolated payment page and still ticks the consent box there; what the
 * staff does is start the flow, which is why `consent_given_at` stays NULL on a
 * staff-raised row (`initiated_by` records who sent it).
 */
paymentMethodsRouter.post(
  '/replace-requests',
  requireModuleWrite('PAYMENTS'),
  async (req: Request, res: Response, next: NextFunction) => {
    const { gymId } = getTenantContext(req);
    const body = parseBody(req, res, z.object({
      member_id: z.coerce.number().int().positive(),
    }));
    if (!body) return;
    const memberId = body.member_id;

    try {
      const { rows: memberRows } = await db.query<{ id: number; email: string | null }>(
        'SELECT id, email FROM members WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
        [memberId, gymId],
      );
      if (!memberRows[0]) return res.status(404).json({ error: 'Member not found' });

      const userMembershipId = await resolveCardUpdateMembership(gymId, memberId);
      if (userMembershipId == null) {
        return res.status(400).json({ error: 'This member has no membership to store a card for' });
      }

      const created = await createCardUpdateRequest({
        gymId,
        memberId,
        memberEmail: memberRows[0].email ?? '',
        userMembershipId,
        initiatedBy: (req as any).auth?.userId ?? null,
        stampConsent: false,
      });

      req.log.info({ memberId, paymentRequestId: created.id }, 'Card replacement link created');
      res.status(201).json(created);
    } catch (err) {
      req.log.error({ err: (err as Error).message }, 'Card replacement link creation failed');
      next(err);
    }
  },
);
