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
import {
  defaultProductForChargeType,
  defaultProductsWithoutChargeType,
  type DefaultGymProduct,
} from '../domain/defaultGymProducts';

/** Columns every seeded row writes, in one place so the two inserts agree. */
const COLUMNS = `
  (gym_id, charge_type_id, name, type, units, amount, currency, billing_frequency,
   status, availability, enrollment_status, is_system, mandatory, validity_days,
   one_time_purchase, tax_rate_id, tax_behavior, created_at, modified_at)
`;

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
 * The values a declared default contributes, in COLUMNS' order from `units`
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
 * Creates the Products a newly created gym starts with. Call it **after** the
 * gym's system tax rate has been inserted: the rate is what the seeded prices
 * are quoted inclusive of, and a seed that ran first would leave every row
 * un-rated.
 */
export async function seedDefaultGymProducts(gymId: string): Promise<void> {
  // #543: a System Product's name and type come from `charge_types` rather
  // than from this module — the catalogue is where they are spelled.
  const { rows: chargeTypes } = await db.query<{ id: number; code: string }>(
    'SELECT id, code FROM charge_types WHERE is_product = 1 ORDER BY id',
  );

  for (const chargeType of chargeTypes) {
    const declared = defaultProductForChargeType(chargeType.code);
    await db.query(
      `INSERT IGNORE INTO products ${COLUMNS}
       SELECT ?, ct.id, ct.name, ?, ?, ?, 'EUR', ?, ?, ?, ?, 1, ?, ?, ?, ${SYSTEM_TAX_RATE},
         'inclusive', UTC_TIMESTAMP(), UTC_TIMESTAMP()
       FROM charge_types ct WHERE ct.id = ?`,
      [gymId, declared?.type ?? 'fee', ...(declared ? configurationValues(declared) : UNDECLARED), gymId, chargeType.id],
    );
  }

  for (const product of defaultProductsWithoutChargeType()) {
    await db.query(
      `INSERT INTO products ${COLUMNS}
       SELECT ?, NULL, ?, ?, ?, ?, 'EUR', ?, ?, ?, ?, 1, ?, ?, ?, ${SYSTEM_TAX_RATE},
         'inclusive', UTC_TIMESTAMP(), UTC_TIMESTAMP()
       FROM DUAL
       WHERE NOT EXISTS (
         SELECT 1 FROM products p
         WHERE p.gym_id = ? AND p.is_system = 1 AND p.name = ?
       )`,
      [gymId, product.name, product.type, ...configurationValues(product), gymId, gymId, product.name],
    );
  }
}
