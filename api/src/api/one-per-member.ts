// #2607 — the "One per Member" Product restriction, enforced server-side.
//
// A Product flagged `one_per_member` may be held once by a member. "Held" is
// read from the assignment's own state rather than from payments: a one-time
// purchase that is pending payment or active (and neither cancelled nor past
// its validity), or a recurring line still running on one of the member's
// Product Sets. `draftSetId` narrows the recurring half to that Draft's own
// lines, because a line the Draft already removed must not block adding it back.

import type { Tx } from '../infra/db';

type Queryable = Pick<Tx, 'query'>;

export async function productIsOnePerMember(q: Queryable, gymId: string, productId: number): Promise<boolean> {
  const { rows } = await q.query<any>(
    'SELECT one_per_member FROM products WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
    [productId, gymId],
  );
  return Boolean(rows[0]?.one_per_member);
}

export async function memberHoldsProduct(
  q: Queryable, gymId: string, memberId: number, productId: number, opts: { draftSetId?: number } = {},
): Promise<boolean> {
  const { rows: purchases } = await q.query<any>(
    `SELECT id FROM member_products_oneoff_snapshot
      WHERE gym_id = ? AND member_id = ? AND product_id = ?
        AND status IN ('pending_payment', 'active') AND cancelled_on IS NULL
        AND (valid_until IS NULL OR valid_until >= UTC_DATE())
      LIMIT 1`,
    [gymId, memberId, productId],
  );
  if (purchases.length > 0) return true;
  const { rows: lines } = opts.draftSetId != null
    ? await q.query<any>(
      `SELECT id FROM member_products_recurrent_snapshot
        WHERE gym_id = ? AND product_set_id = ? AND product_id = ?
          AND (ends_at IS NULL OR ends_at >= UTC_DATE())
        LIMIT 1`,
      [gymId, opts.draftSetId, productId],
    )
    : await q.query<any>(
      `SELECT r.id FROM member_products_recurrent_snapshot r
         JOIN product_sets ps ON ps.id = r.product_set_id AND ps.gym_id = r.gym_id
        WHERE r.gym_id = ? AND ps.owner_member_id = ? AND r.product_id = ?
          AND ps.status IN ('draft', 'pending_payment', 'active')
          AND (r.ends_at IS NULL OR r.ends_at >= UTC_DATE())
        LIMIT 1`,
      [gymId, memberId, productId],
    );
  return lines.length > 0;
}

/** True when the Product is `one_per_member` and the member already holds it. */
export async function violatesOnePerMember(
  q: Queryable, gymId: string, memberId: number, productId: number, opts: { draftSetId?: number } = {},
): Promise<boolean> {
  if (!(await productIsOnePerMember(q, gymId, productId))) return false;
  return memberHoldsProduct(q, gymId, memberId, productId, opts);
}

export const ONE_PER_MEMBER_MESSAGE = 'A member can only have one assignment of this product';
