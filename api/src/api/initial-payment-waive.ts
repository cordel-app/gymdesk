/**
 * #3284 stage 2 — `POST /product-sets/:id/initial-payment/waive` and `…/revert-waive`.
 *
 * Staff waive one line of an In Cart Product Set's Initial Payment, or revert it. The body names the
 * line by its stable `line_key` (the review's `initial_payment.lines[].line_key`) and nothing else:
 * the client never sends an amount, the charge is re-priced from `commitCharge()` and the waiver is
 * judged against it (`waiveRefusal()`). Everything runs under the Draft's row lock (`lockDraft()`:
 * only an `in_cart`, unexpired set) and the cart's, so it cannot race an edit, Save & Pay, activation
 * or cancellation; a successful change refreshes the cart's expiry (#3274) and writes one audit row
 * on the Product Set.
 */
import { db } from '../infra/db';
import { getTenantContext } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import { isRefusal, lockDraft } from './product-set-draft';
import { purchaseOfSet, refreshSetCart } from './purchases';
import { commitCharge } from './product-set-checkout';
import { deleteInitialPaymentWaiver, insertInitialPaymentWaiver, loadInitialPaymentWaivers } from './initial-payment-waivers';
import { waiveRefusal } from '../domain/initialPaymentWaiver';

const LINE_KEY_MAX = 120;

type Outcome =
  | { kind: 'ok' }
  | { kind: 'refused'; status: number; body: Record<string, unknown> };

export async function initialPaymentWaiveHandler(req: any, res: any, next: any, waive: boolean) {
  try {
    const { gymId } = getTenantContext(req);
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(404).json({ error: 'ProductSet not found' });
    const lineKey = req.body?.line_key;
    if (typeof lineKey !== 'string' || lineKey.trim() === '' || lineKey.length > LINE_KEY_MAX) {
      return res.status(400).json({ error: 'line_key_required', message: 'line_key is required' });
    }

    const out = await db.transaction(async (tx): Promise<Outcome> => {
      const draft = await lockDraft(tx, gymId, id);
      if (isRefusal(draft)) {
        if (draft.kind === 'not_found') return { kind: 'refused', status: 404, body: { error: 'ProductSet not found' } };
        if (draft.kind === 'expired') return { kind: 'refused', status: 410, body: { error: 'draft_expired' } };
        return { kind: 'refused', status: 409, body: { error: 'not_a_draft', status: (draft as any).status ?? null } };
      }
      const purchaseId = await purchaseOfSet(tx, gymId, id);
      if (purchaseId == null) return { kind: 'refused', status: 409, body: { error: 'no_cart' } };
      const { rows: cart } = await tx.query<{ status: string }>(
        'SELECT status FROM purchases WHERE id = ? AND gym_id = ? FOR UPDATE', [purchaseId, gymId]);
      if (cart[0]?.status !== 'in_cart') return { kind: 'refused', status: 409, body: { error: 'not_in_cart', status: cart[0]?.status ?? null } };

      if (waive) {
        const { rows: setRows } = await tx.query<any>('SELECT * FROM product_sets WHERE id = ? AND gym_id = ?', [id, gymId]);
        const { charge } = await commitCharge(gymId, setRows[0], tx, { applyWaivers: false });
        const waived = await loadInitialPaymentWaivers(tx, gymId, id);
        const refusal = waiveRefusal(charge?.lines ?? [], lineKey, waived);
        if (refusal) return { kind: 'refused', status: refusal === 'line_not_found' ? 404 : 409, body: { error: refusal } };
        await insertInitialPaymentWaiver(tx, gymId, purchaseId, lineKey);
      } else if (!(await deleteInitialPaymentWaiver(tx, gymId, purchaseId, lineKey))) {
        return { kind: 'refused', status: 409, body: { error: 'not_waived' } };
      }
      await refreshSetCart(tx, gymId, id);
      return { kind: 'ok' };
    });
    if (out.kind === 'refused') return res.status(out.status).json(out.body);

    recordAudit(req, {
      action: waive ? 'waive_initial_payment_line' : 'revert_initial_payment_waive',
      entityType: 'product_set', entityId: id,
      previous: { line_key: lineKey, waived: !waive },
      next: { line_key: lineKey, waived: waive },
    });
    res.json({ product_set_id: id, line_key: lineKey, waived: waive });
  } catch (err) { next(err); }
}
