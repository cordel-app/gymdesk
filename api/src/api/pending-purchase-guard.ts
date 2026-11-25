/**
 * #3355 stage 1 — a member with a Purchase awaiting payment starts no other purchase.
 *
 * "Awaiting payment" is the cart's own derived status (`purchases.status = 'pending_payment'`,
 * kept in step with what the cart holds by `syncPurchase()`), so the restriction lifts by itself the
 * moment that checkout completes, is cancelled or expires (#3307 stage 3): nothing here stores a flag
 * and nothing must clear one. A historical purchase in any other status never blocks.
 *
 * Asked by the staff entry points behind Admin → Member → Products' *+ Add Product* and *+ Add
 * Membership Plan* (`POST /members/:id/product-purchases`, `POST /membership-plans/:id/assign`,
 * `POST /product-sets/:id/plans`) before they write anything, and reported to the Admin as
 * `has_pending_payment_purchase` on the member's configuration read, which only decides whether the
 * two buttons open their workflow or say why not.
 */
import type { Tx } from '../infra/db';

type Conn = Pick<Tx, 'query'>;

export const PURCHASE_PENDING_PAYMENT_CODE = 'purchase_pending_payment';

/** Whether `memberId` owns a Purchase awaiting payment. */
export async function hasPendingPaymentPurchase(exec: Conn, gymId: string, memberId: number): Promise<boolean> {
  const { rows } = await exec.query<{ id: number }>(
    `SELECT id FROM purchases WHERE gym_id = ? AND owner_member_id = ? AND status = 'pending_payment' LIMIT 1`,
    [gymId, memberId],
  );
  return rows.length > 0;
}

/** The refusal body every guarded route answers with `409`. */
export function pendingPaymentPurchaseRefusal() {
  return {
    error: 'You cannot make new purchases until the current pending payment has been completed.',
    code: PURCHASE_PENDING_PAYMENT_CODE,
  };
}

/**
 * Answers `409 purchase_pending_payment` and `true` when `memberId` holds a Purchase awaiting
 * payment; `false` (nothing written to `res`) otherwise.
 */
export async function refuseWhilePurchasePending(
  exec: Conn, gymId: string, memberId: number, res: { status(code: number): { json(body: unknown): unknown } },
): Promise<boolean> {
  if (!(await hasPendingPaymentPurchase(exec, gymId, memberId))) return false;
  res.status(409).json(pendingPaymentPurchaseRefusal());
  return true;
}
