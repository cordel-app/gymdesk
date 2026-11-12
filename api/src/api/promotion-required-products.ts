// #2374 — the SQL half of `domain/promotionRequiredProducts.ts`: the grants the chosen
// Promotions carry, and the Products the Member already holds.

import { db } from '../infra/db';
import { PRODUCT_PROMOTION_TARGET } from '../domain/memberProductPromotion';
import {
  missingMandatoryProducts,
  type PromotionGrantRef,
  type RequiredProduct,
} from '../domain/promotionRequiredProducts';

const GRANT_TABLES = ['promotion_session', 'promotion_oneoff', 'promotion_periodical'] as const;

/**
 * Products the Member holds or is configuring: purchases (draft/pending/active) and open recurring lines.
 * Every arm reads the Product snapshot tables (#2126 stage 3e moved the recurring one).
 */
async function loadHeldProductIds(gymId: string, memberId: number): Promise<Set<number>> {
  const { rows } = await db.query<{ product_id: number }>(
    `SELECT product_id FROM product_session_snapshots
      WHERE gym_id = ? AND member_id = ? AND status IN ('draft', 'pending_payment', 'active')
     UNION
     SELECT product_id FROM product_oneoff_snapshots
      WHERE gym_id = ? AND member_id = ? AND status IN ('draft', 'pending_payment', 'active')
     UNION
     SELECT r.product_id FROM product_periodical_snapshots r
       JOIN product_set_periodical_snapshots lnk ON lnk.product_periodical_snapshot_id = r.id
       JOIN product_sets ps ON ps.id = lnk.product_set_id AND ps.gym_id = r.gym_id
      WHERE r.gym_id = ? AND ps.owner_member_id = ? AND r.source_id IS NOT NULL AND r.ends_at IS NULL
        AND ps.status IN ('draft', 'pending_payment', 'active')`,
    [gymId, memberId, gymId, memberId, gymId, memberId],
  );
  return new Set(rows.map((r) => Number(r.product_id)));
}

/** The mandatory Products still to be added for `productId` under `promotionIds`. */
export async function loadMissingMandatoryProducts(
  gymId: string,
  memberId: number,
  productId: number,
  promotionIds: readonly number[],
): Promise<RequiredProduct[]> {
  if (promotionIds.length === 0) return [];
  const marks = promotionIds.map(() => '?').join(',');
  const grants: PromotionGrantRef[] = [];
  for (const table of GRANT_TABLES) {
    const { rows } = await db.query<any>(
      `SELECT b.promotion_id, b.product_id, pr.name AS product_name, b.requirement
         FROM ${table} b
         JOIN promotions p ON p.id = b.promotion_id AND p.gym_id = b.gym_id
         JOIN products pr ON pr.id = b.product_id AND pr.gym_id = b.gym_id
        WHERE b.gym_id = ? AND b.promotion_id IN (${marks})
          AND p.applies_to = ? AND pr.deleted_at IS NULL
        ORDER BY pr.name ASC`,
      [gymId, ...promotionIds, PRODUCT_PROMOTION_TARGET],
    );
    grants.push(...rows);
  }
  if (grants.length === 0) return [];
  return missingMandatoryProducts(grants, productId, await loadHeldProductIds(gymId, memberId));
}
