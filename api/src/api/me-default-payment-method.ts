/**
 * #3503 — `GET /me/default-payment-method`: the signed-in member's Default
 * Payment Method, read-only, for the Members App Profile.
 *
 * The member is never named by the request (`resolveMemberId()`, #1036), and
 * this router writes nothing: the one writer of `members.default_payment_method`
 * stays the staff `PUT /members/:id/default-payment-method` (#3497). The value is
 * resolved exactly as the staff read resolves it (`resolveDefaultPaymentMethod()`:
 * no stored preference reads as Automated) and drawn with the same catalogue
 * entry (`catalogueCodeForOption()`), so the member sees what staff saved.
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { getTenantContext, requireRole } from '../infra/tenantContext';
import { db } from '../infra/db';
import { getRequestLocale } from '../infra/locale';
import { resolveMemberId } from './me';
import { loadCatalogue } from './member-default-payment-method';
import { catalogueCodeForOption, resolveDefaultPaymentMethod } from '../domain/memberDefaultPaymentMethod';

export const meDefaultPaymentMethodRouter = Router();

meDefaultPaymentMethodRouter.get('/', requireRole('member'), async (req: Request, res: Response, next: NextFunction) => {
  const ctx = getTenantContext(req);
  const { gymId } = ctx;
  try {
    const memberId = await resolveMemberId(gymId, ctx);
    const { rows } = await db.query<{ default_payment_method: string | null }>(
      'SELECT default_payment_method FROM members WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
      [memberId, gymId]);
    if (rows.length === 0) return res.status(404).json({ error: 'Member not found' });
    const stored = rows[0].default_payment_method ?? null;
    const code = resolveDefaultPaymentMethod(stored);
    const entry = (await loadCatalogue(getRequestLocale(req))).get(catalogueCodeForOption(code)) ?? null;
    res.json({
      default_payment_method: code,
      is_explicit: stored != null,
      method: {
        code,
        // Automated is worded by the app's own locale key, as on the Admin Profile.
        name: code === 'automated' ? null : (entry?.name ?? code),
        description: entry?.description ?? null,
        image_url: entry?.image_url ?? null,
        image_thumbnail_url: entry?.image_thumbnail_url ?? null,
      },
    });
  } catch (err: any) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});
