import { db } from '../infra/db';
import { BASE_FOOD_TABLES, LEGACY_FOOD_TABLES } from '../domain/nutritionLibrary';

/**
 * #1849 stage F2 — the transitional mirror of a Base food onto the legacy System row
 * of the same id: the gym-facing router and the plan tables still reference the
 * legacy row by id. Removed with the legacy rows in the final Foods stage. Used by
 * Cordel's router and by the Base image backfill script.
 */
/** Copies a Base food and its junctions onto the legacy row of the same id (the transitional mirror). */
export async function mirrorFoodToLegacy(id: number | string): Promise<void> {
  const L = LEGACY_FOOD_TABLES;
  const B = BASE_FOOD_TABLES;
  await db.transaction(async (tx) => {
    await tx.query(
      `UPDATE ${L.items} n JOIN ${B.items} b ON b.id = n.id
          SET n.name = b.name, n.description = b.description, n.image_url = b.image_url,
              n.status = IF(b.deleted_at IS NULL, 'active', 'deleted'),
              n.modified_at = b.modified_at, n.modified_by = b.modified_by,
              n.deleted_at = b.deleted_at, n.deleted_by = b.deleted_by
        WHERE n.id = ? AND n.gym_id IS NULL`,
      [id],
    );
    await tx.query(`DELETE FROM ${L.categories} WHERE item_id = ?`, [id]);
    await tx.query(`INSERT INTO ${L.categories} (item_id, category_id, created_at) SELECT item_id, category_id, created_at FROM ${B.categories} WHERE item_id = ?`, [id]);
    await tx.query(`DELETE FROM ${L.qualities} WHERE item_id = ?`, [id]);
    await tx.query(`INSERT INTO ${L.qualities} (item_id, quality_id, created_at) SELECT item_id, quality_id, created_at FROM ${B.qualities} WHERE item_id = ?`, [id]);
    await tx.query(`DELETE FROM ${L.translations} WHERE item_id = ?`, [id]);
    await tx.query(`INSERT INTO ${L.translations} (item_id, locale, name, created_at, modified_at) SELECT item_id, locale, name, created_at, modified_at FROM ${B.translations} WHERE item_id = ?`, [id]);
    await tx.query(`DELETE FROM ${L.descriptions} WHERE item_id = ?`, [id]);
    await tx.query(`INSERT INTO ${L.descriptions} (item_id, locale, description, created_at, modified_at) SELECT item_id, locale, description, created_at, modified_at FROM ${B.descriptions} WHERE item_id = ?`, [id]);
  });
}

