/**
 * #3305 — the I/O half of `staffPreparesCart()` (`domain/shoppingCart.ts`): whether the member's
 * open cart is one staff are still preparing, and the one refusal a member's write answers while it
 * is. The cart is the owner's one In Cart purchase (`purchases_open_owner_key`), so a Product Set
 * Draft and the standalone one-time purchases beside it are the same cart and take the same answer.
 * An expired cart is no cart (the sweep removes it), so it locks nothing.
 */
import { db, type Tx } from '../infra/db';
import { purchaseCartExpiredSql } from '../domain/cartExpiry';
import { AWAITING_STAFF_SETUP, staffPreparesCart } from '../domain/shoppingCart';

type Conn = Pick<Tx, 'query'>;

export async function staffPreparesOpenCart(exec: Conn, gymId: string, ownerMemberId: number): Promise<boolean> {
  const { rows } = await exec.query<{ status: string; channel: string | null }>(
    `SELECT pu.status, pu.channel FROM purchases pu
      WHERE pu.gym_id = ? AND pu.owner_member_id = ? AND pu.status = 'in_cart'
        AND NOT ${purchaseCartExpiredSql('pu')}
      LIMIT 1`,
    [gymId, ownerMemberId]);
  return staffPreparesCart(rows[0]);
}

/** The answer to a member's write on (or add to) a cart staff are still preparing. */
export function refuseStaffPreparedCart(res: any, message = 'Your gym is still preparing your cart. It can be paid here once the gym makes it available.') {
  res.status(409).json({ error: AWAITING_STAFF_SETUP, message });
}

/** Answers the refusal and returns true when the member's cart is staff-prepared. */
export async function refuseIfStaffPreparesCart(res: any, gymId: string, memberId: number): Promise<boolean> {
  if (!(await staffPreparesOpenCart(db, gymId, memberId))) return false;
  refuseStaffPreparedCart(res);
  return true;
}
