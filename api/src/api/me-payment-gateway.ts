/**
 * #3512 — `GET /me/payment-gateway-status`: whether the signed-in member must
 * be told to register with the official payment gateway. The I/O half of
 * `domain/paymentGatewayRegistration.ts`, which decides it.
 *
 * The member is never named by the request (`resolveMemberId()`, #1036). The
 * token itself never leaves the API: the answer says only whether one exists.
 * Nothing is written, so the Members App can ask on every sign-in and the
 * warning stops by itself once a token is stored.
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { getTenantContext, requireRole } from '../infra/tenantContext';
import { db } from '../infra/db';
import { resolveMemberId } from './me';
import { memberMayViewPayments } from './family-add-rights';
import {
  gatewayRegistrationRequired,
  resolveDefaultPaymentMethod,
} from '../domain/paymentGatewayRegistration';

/** The provider whose stored token an Automated payment is taken with (`payment_methods.provider`). */
const GATEWAY_PROVIDER = 'monei';

export async function hasMoneiToken(gymId: string, memberId: number): Promise<boolean> {
  const { rows } = await db.query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM payment_methods
      WHERE gym_id = ? AND member_id = ? AND provider = ?
        AND payment_token IS NOT NULL AND payment_token <> ''`,
    [gymId, memberId, GATEWAY_PROVIDER],
  );
  return Number(rows[0]?.n ?? 0) > 0;
}

export const mePaymentGatewayRouter = Router();

mePaymentGatewayRouter.get('/', requireRole('member'), async (req: Request, res: Response, next: NextFunction) => {
  const ctx = getTenantContext(req);
  const { gymId } = ctx;
  try {
    const memberId = await resolveMemberId(gymId, ctx);
    const [paysForSelf, tokenStored] = await Promise.all([
      memberMayViewPayments(db, gymId, memberId),
      hasMoneiToken(gymId, memberId),
    ]);
    const { rows: pref } = await db.query<{ default_payment_method: string | null }>(
      'SELECT default_payment_method FROM members WHERE id = ? AND gym_id = ?', [memberId, gymId]);
    // #3497: the member's stored preference, Automated when none.
    const defaultPaymentMethod = resolveDefaultPaymentMethod(pref[0]?.default_payment_method ?? null);
    res.json({
      default_payment_method: defaultPaymentMethod,
      has_monei_token: tokenStored,
      registration_required: gatewayRegistrationRequired({ defaultPaymentMethod, hasMoneiToken: tokenStored, paysForSelf }),
    });
  } catch (err: any) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});
