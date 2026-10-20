// #1149: the one writer of a new gym's default Products.
//
// The declaration half is `domain/defaultGymProducts.ts`; this is the I/O half
// — the same split #1121 and #1123 use. Both gym-creation paths
// (`POST /gyms` and `POST /gyms/:id/duplicate`) call `seedDefaultGymProducts()`
// and neither spells an INSERT of its own, so the two cannot drift into
// creating differently configured catalogues (the duplicate path's own insert
// had already lost `is_system = 1`).
//
// Idempotency is the database's, not a read-then-write:
//
//   * a charge-type-backed row is `INSERT IGNORE`, which
//     `products_gym_id_charge_type_unique` (migration 090, renamed in 214)
//     turns into a no-op for a gym that already has that Product;
//   * the Personal Training package has no `charge_type_id` to be keyed on, so
//     it keeps #371's `WHERE NOT EXISTS` guard on `(gym_id, is_system, name)`.
//
// Neither ever UPDATEs, which is §7 of the ticket: a Product a gym has since
// repriced, renamed, deactivated or deleted is left exactly as it is, and a
// re-run of a gym's initialization adds nothing. Soft-deleted rows are
// deliberately *not* excluded from either guard — a Product the gym deleted
// stays deleted rather than being resurrected by the next run.

import { db } from '../infra/db';
import { SYSTEM_ACTOR } from '../domain/auditActor';
import { type DefaultGymProduct } from '../domain/defaultGymProducts';
import { toDefaultGymProduct, type BaseProductRow } from '../domain/baseProducts';


/**
 * The gym's own system tax rate — the `Standard VAT` 21% row seeded beside the
 * products, and the one `selectPlanTaxRates()` (#817) calls the gym default.
 * A correlated subquery rather than a JOIN, so it can never fan a seed out
 * into duplicate rows, and `NULL` rather than a failure when a gym has none.
 */
const SYSTEM_TAX_RATE = `
  (SELECT tr.id FROM tax_rates tr
   WHERE tr.gym_id = ? AND tr.is_system = 1 AND tr.deleted_at IS NULL
   ORDER BY tr.id LIMIT 1)
`;

/**
 * The values a declared default contributes, in the INSERT's column order from `units`
 * onwards. `amount` stays `null` for a Product the gym must price itself
 * (§5's Premium Fitness App), which reads as `—` and never as €0.00.
 */
function configurationValues(product: DefaultGymProduct) {
  return [
    product.units,
    product.amount,
    product.billingFrequency,
    product.status,
    // The legacy `availability` column, kept in step with `status` exactly as
    // `PUT /products/:id` and the activate/deactivate routes keep it. Nothing
    // reads it any more (the `?availability=` filter maps onto `status`), but
    // a seeded row that disagreed with itself from day one would be a puzzle
    // for whoever next looks at the table.
    product.status === 'active' ? 'available' : 'unavailable',
    product.enrollmentStatus,
    product.mandatory ? 1 : 0,
    product.validityDays,
    product.oneTimePurchase ? 1 : 0,
  ];
}

/**
 * The values of a charge type this module declares no default for. It is still
 * seeded — name and type and the column defaults — because that is what
 * `POST /gyms` did before #1149 and a gym must have a Product for every
 * `is_product` charge type the catalogue holds.
 */
const UNDECLARED: ReturnType<typeof configurationValues> = [
  null, null, null, 'active', 'available', 'public', 0, null, 0,
];

/**
 * Creates one gym-owned Product from a `base_products` template and records
 * the template in `products.base_product_id` (#1851). The one INSERT both gym
 * creation and the Import System Products action go through, so the two map a
 * template identically. Never an UPDATE, and idempotent at the database:
 *
 *   * a template with a charge type is `INSERT IGNORE` under
 *     `products_gym_id_charge_type_unique` and `products_gym_base_product_unique`
 *     — a gym that already has that Product (imported, seeded before #1851 or
 *     since deleted) gets nothing, and the name still comes from `charge_types`;
 *   * a template with no charge type is guarded by `WHERE NOT EXISTS` on the
 *     gym's `is_system` Product of that name (the pre-#1851 rows carry no
 *     `base_product_id`), and by the unique key for a concurrent twin.
 *
 * Returns whether a Product was created.
 */
export async function insertProductFromTemplate(
  gymId: string,
  template: BaseProductRow,
  actor: string | null,
): Promise<boolean> {
  const declared = toDefaultGymProduct(template);
  if (declared.chargeTypeCode !== null) {
    const { rowCount } = await db.query(
      `INSERT IGNORE INTO products
(gym_id, charge_type_id, base_product_id, name, type, units, amount, currency, billing_frequency,
   status, availability, enrollment_status, is_system, mandatory, validity_days,
   one_time_purchase, tax_rate_id, tax_behavior, created_at, modified_at, created_by)
       SELECT ?, ct.id, ?, ct.name, ?, ?, ?, 'EUR', ?, ?, ?, ?, 1, ?, ?, ?, ${SYSTEM_TAX_RATE},
         'inclusive', UTC_TIMESTAMP(), UTC_TIMESTAMP(), ?
       FROM charge_types ct WHERE ct.code = ?`,
      [gymId, template.id, declared.type, ...configurationValues(declared), gymId, actor, declared.chargeTypeCode],
    );
    return rowCount > 0;
  }
  const { rowCount } = await db.query(
    `INSERT IGNORE INTO products
(gym_id, charge_type_id, base_product_id, name, type, units, amount, currency, billing_frequency,
   status, availability, enrollment_status, is_system, mandatory, validity_days,
   one_time_purchase, tax_rate_id, tax_behavior, created_at, modified_at, created_by)
     SELECT ?, NULL, ?, ?, ?, ?, ?, 'EUR', ?, ?, ?, ?, 1, ?, ?, ?, ${SYSTEM_TAX_RATE},
       'inclusive', UTC_TIMESTAMP(), UTC_TIMESTAMP(), ?
     FROM DUAL
     WHERE NOT EXISTS (
       SELECT 1 FROM products p
       WHERE p.gym_id = ? AND p.is_system = 1 AND p.charge_type_id IS NULL AND p.name = ?
     )`,
    [gymId, template.id, declared.name, declared.type, ...configurationValues(declared), gymId, actor, gymId, declared.name],
  );
  return rowCount > 0;
}

/**
 * Creates the Products a newly created gym starts with. Call it **after** the
 * gym's system tax rate has been inserted: the rate is what the seeded prices
 * are quoted inclusive of, and a seed that ran first would leave every row
 * un-rated.
 */
export async function seedDefaultGymProducts(gymId: string, actor: string | null = SYSTEM_ACTOR): Promise<void> {
  // #1822: the declarations are the live templates Cordel administers in
  // `base_products` (seeded by migration 298 from `DEFAULT_GYM_PRODUCTS`). A
  // template edited or deleted there changes only the gyms created from now on.
  const { rows: templates } = await db.query<BaseProductRow>(
    'SELECT * FROM base_products WHERE deleted_at IS NULL ORDER BY id',
  );

  // #543: a System Product's name and type come from `charge_types` rather
  // than from this module — the catalogue is where they are spelled.
  const { rows: chargeTypes } = await db.query<{ id: number; code: string }>(
    'SELECT id, code FROM charge_types WHERE is_product = 1 ORDER BY id',
  );

  // A charge type no live template declares is still seeded, with the column
  // defaults, because a gym must have a Product for every `is_product` row.
  for (const chargeType of chargeTypes) {
    if (templates.some((t) => t.charge_type_code === chargeType.code)) continue;
    await db.query(
      `INSERT IGNORE INTO products
(gym_id, charge_type_id, name, type, units, amount, currency, billing_frequency,
   status, availability, enrollment_status, is_system, mandatory, validity_days,
   one_time_purchase, tax_rate_id, tax_behavior, created_at, modified_at, created_by)
       SELECT ?, ct.id, ct.name, ?, ?, ?, 'EUR', ?, ?, ?, ?, 1, ?, ?, ?, ${SYSTEM_TAX_RATE},
         'inclusive', UTC_TIMESTAMP(), UTC_TIMESTAMP(), ?
       FROM charge_types ct WHERE ct.id = ?`,
      [gymId, 'fee', ...UNDECLARED, gymId, actor, chargeType.id],
    );
  }

  for (const template of templates) {
    await insertProductFromTemplate(gymId, template, actor);
  }
}

export interface ImportableBaseProduct extends BaseProductRow {
  imported: boolean;
  imported_product_id: number | null;
}

/**
 * The live templates and, for the given gym, which are already a Product of it
 * (#1851). "Imported" is the Product that records the template in
 * `base_product_id`, else — for a gym created before the column existed and not
 * covered by its backfill — the System Product the template would create: same
 * charge type, or same name for the template with none. A deleted Product still
 * counts: the unique keys would refuse a second one, and a deleted Product stays
 * deleted.
 */
export async function listBaseProductsForGym(gymId: string, q?: string): Promise<ImportableBaseProduct[]> {
  const params: unknown[] = [gymId, gymId, gymId];
  let where = 'b.deleted_at IS NULL';
  if (q) {
    where += ' AND (b.name LIKE ? OR b.charge_type_code LIKE ?)';
    params.push(`%${q}%`, `%${q}%`);
  }
  const { rows } = await db.query<any>(
    `SELECT b.*,
       COALESCE(
         (SELECT p.id FROM products p WHERE p.gym_id = ? AND p.base_product_id = b.id LIMIT 1),
         (SELECT p.id FROM products p JOIN charge_types ct ON ct.id = p.charge_type_id
            WHERE p.gym_id = ? AND b.charge_type_code IS NOT NULL AND ct.code = b.charge_type_code LIMIT 1),
         (SELECT p.id FROM products p
            WHERE p.gym_id = ? AND b.charge_type_code IS NULL AND p.is_system = 1
              AND p.charge_type_id IS NULL AND p.name = b.name LIMIT 1)
       ) AS imported_product_id
     FROM base_products b
     WHERE ${where}
     ORDER BY b.name, b.id`,
    params,
  );
  return rows.map((r: any) => ({
    ...r,
    imported: r.imported_product_id !== null,
    imported_product_id: r.imported_product_id === null ? null : Number(r.imported_product_id),
  }));
}

/**
 * Imports the chosen live templates into the gym (#1851). Skips what the gym
 * already has and reports it; never updates an existing Product. Each template
 * is one idempotent INSERT, so two concurrent requests create it once.
 */
export async function importBaseProducts(
  gymId: string,
  baseProductIds: number[],
  actor: string | null,
): Promise<{ imported: number[]; skipped: number[] }> {
  const imported: number[] = [];
  const skipped: number[] = [];
  const available = await listBaseProductsForGym(gymId);
  for (const id of baseProductIds) {
    const template = available.find((t) => t.id === id);
    if (!template || template.imported) {
      skipped.push(id);
      continue;
    }
    (await insertProductFromTemplate(gymId, template, actor)) ? imported.push(id) : skipped.push(id);
  }
  return { imported, skipped };
}
