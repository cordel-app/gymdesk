import { db, Tx } from '../infra/db';

/**
 * #546: links Session-type ('type' = 'sessions') Sellable Items to one or
 * more Professional Services (#484) via the `sellable_item_professional_services`
 * join table (migration 153). Many-to-many: a session package may bundle
 * sessions delivered by different Professional Services. Mirrors the shape
 * of `nutritionLibrary.ts`'s category/quality helpers (#501).
 */

export interface LinkedProfessionalService {
  id: number;
  name: string;
  is_system: number;
}

/** Return linked Professional Services for a set of sellable item IDs, as a map: sellable_item_id -> [{id, name, is_system}]. */
export async function loadProfessionalServicesMap(
  sellableItemIds: number[],
): Promise<Record<number, LinkedProfessionalService[]>> {
  if (sellableItemIds.length === 0) return {};
  const marks = sellableItemIds.map(() => '?').join(',');
  const { rows } = await db.query<{ sellable_item_id: number; id: number; name: string; is_system: number }>(
    `SELECT sips.sellable_item_id, ps.id, ps.name, ps.is_system
     FROM sellable_item_professional_services sips
     JOIN professional_services ps ON ps.id = sips.professional_service_id
     WHERE sips.sellable_item_id IN (${marks}) AND ps.deleted_at IS NULL
     ORDER BY ps.is_system DESC, ps.name ASC`,
    sellableItemIds,
  );
  const map: Record<number, LinkedProfessionalService[]> = {};
  for (const row of rows) {
    if (!map[row.sellable_item_id]) map[row.sellable_item_id] = [];
    map[row.sellable_item_id].push({ id: row.id, name: row.name, is_system: row.is_system });
  }
  return map;
}

/**
 * Validate that `ids` references Professional Services visible to this gym
 * (a global system row, or a row owned by this gym) and not soft-deleted —
 * the same visibility rule `GET /professional-services` uses. Empty/omitted
 * selection is allowed (#546 requirement 14 — no invented "at least one"
 * rule; a Session item may have zero linked services).
 */
export async function validateProfessionalServiceIds(gymId: string, ids: unknown): Promise<{ error: string } | null> {
  if (ids === undefined || ids === null) return null;
  if (!Array.isArray(ids)) return { error: 'professional_service_ids must be an array' };
  if (ids.length === 0) return null;
  if (ids.some((id) => typeof id !== 'number' || !Number.isInteger(id) || id <= 0)) {
    return { error: 'professional_service_ids must be positive integers' };
  }
  const uniqueIds = Array.from(new Set(ids));
  const marks = uniqueIds.map(() => '?').join(',');
  const { rows } = await db.query<{ id: number }>(
    `SELECT id FROM professional_services
     WHERE id IN (${marks}) AND (gym_id IS NULL OR gym_id = ?) AND deleted_at IS NULL`,
    [...uniqueIds, gymId],
  );
  if (rows.length !== uniqueIds.length) {
    return { error: 'One or more professional_service_ids are invalid, or do not belong to this gym' };
  }
  return null;
}

/**
 * Replace all Professional Service links for a sellable item inside the
 * caller's transaction, so the join rows are always written atomically
 * alongside the sellable item's own insert/update (#546 requirement 8).
 * Pass an empty array (or call directly) to clear all links, which is what
 * happens when a Sellable Item's type changes away from 'sessions'.
 */
export async function replaceProfessionalServices(
  tx: Tx,
  gymId: string,
  sellableItemId: number,
  professionalServiceIds: number[],
  createdByMembershipId: number | null,
): Promise<void> {
  await tx.query('DELETE FROM sellable_item_professional_services WHERE sellable_item_id = ?', [sellableItemId]);
  const uniqueIds = Array.from(new Set(professionalServiceIds));
  for (const psId of uniqueIds) {
    await tx.query(
      `INSERT INTO sellable_item_professional_services
         (gym_id, sellable_item_id, professional_service_id, created_by_membership_id)
       VALUES (?, ?, ?, ?)`,
      [gymId, sellableItemId, psId, createdByMembershipId],
    );
  }
}
