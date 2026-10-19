/**
 * #1822 — Cordel → Base Products: the platform's templates for the Products a
 * newly created gym starts with.
 *
 * `base_products` is a separate global table (no `gym_id`); `products` stays a
 * per-gym table and is untouched. A row carries what `defaultGymProducts.ts`
 * used to hold in code: the configuration a generated Product is created with.
 * Editing or deleting a template changes only the *next* gym created — a
 * Product already generated is the gym's own.
 *
 *  - `charge_type_code` — set for a template that configures the System Product
 *    seeded from that `charge_types` row (the generated Product's name still
 *    comes from the catalogue, #543); NULL for a template with no charge type
 *    (the Personal Training package), which is generated under its own `name`.
 *  - Soft delete (`deleted_at`). A template is unique among live rows only
 *    (`template_key`, migration 183's VIRTUAL generated-column device), so a
 *    deleted template's code or name can be reused.
 *
 * The seed mirrors `DEFAULT_GYM_PRODUCTS` (a migration is plain JS and cannot
 * import it); a unit test asserts the two agree. It inserts only into an empty
 * table, so re-running it never overwrites a template Cordel has since edited.
 */

const TABLE = 'base_products';

// [charge_type_code, name, type, units, amount, billing_frequency, status,
//  enrollment_status, mandatory, validity_days, one_time_purchase]
const SEEDS = [
  ['access_key', 'Access Key', 'fee', null, 5, 'once', 'inactive', 'staff_only', 0, null, 0],
  ['insurance_fee', 'Insurance Fee', 'fee', null, 20, 'year', 'active', 'staff_only', 1, null, 0],
  ['locker_rental', 'Locker Rental', 'fee', null, 15, 'month', 'active', 'public', 0, null, 0],
  ['parking_fee', 'Parking Fee', 'fee', null, 30, 'month', 'inactive', 'public', 0, null, 0],
  [null, 'Personal Training Class Package (10 Sessions)', 'sessions', 10, 500, 'once', 'active', 'public', 0, 182, 0],
  ['premium_fitness_app', 'Premium Fitness App', 'fee', null, null, 'once', 'inactive', 'staff_only', 0, null, 1],
  ['registration_fee', 'Registration Fee', 'fee', null, 100, 'once', 'active', 'staff_only', 1, null, 1],
];

exports.up = async (knex) => {
  if (!(await knex.schema.hasTable(TABLE))) {
    await knex.raw(`
      CREATE TABLE ${TABLE} (
        id                INT UNSIGNED NOT NULL AUTO_INCREMENT,
        charge_type_code  VARCHAR(50)  NULL,
        name              VARCHAR(150) NOT NULL,
        type              VARCHAR(20)  NOT NULL DEFAULT 'fee',
        units             INT UNSIGNED NULL,
        amount            DECIMAL(10,2) NULL,
        billing_frequency VARCHAR(20)  NOT NULL DEFAULT 'once',
        status            VARCHAR(20)  NOT NULL DEFAULT 'active',
        enrollment_status VARCHAR(20)  NOT NULL DEFAULT 'public',
        mandatory         TINYINT(1)   NOT NULL DEFAULT 0,
        validity_days     INT UNSIGNED NULL,
        one_time_purchase TINYINT(1)   NOT NULL DEFAULT 0,
        created_at   DATETIME     NOT NULL DEFAULT (UTC_TIMESTAMP()),
        created_by   VARCHAR(255) NULL,
        modified_at  DATETIME     NULL,
        modified_by  VARCHAR(255) NULL,
        deleted_at   DATETIME     NULL,
        deleted_by   VARCHAR(255) NULL,
        template_key VARCHAR(200)
          GENERATED ALWAYS AS (IF(deleted_at IS NULL, COALESCE(charge_type_code, CONCAT('name:', name)), NULL)) VIRTUAL,
        PRIMARY KEY (id),
        UNIQUE KEY base_products_template_key (template_key),
        CONSTRAINT chk_base_products_type CHECK (type IN ('fee','sessions')),
        CONSTRAINT chk_base_products_frequency
          CHECK (billing_frequency IN ('once','four_weeks','month','year')),
        CONSTRAINT chk_base_products_status CHECK (status IN ('active','inactive')),
        CONSTRAINT chk_base_products_enrollment CHECK (enrollment_status IN ('public','staff_only'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);

    for (const s of SEEDS) {
      await knex.raw(
        `INSERT INTO ${TABLE}
           (charge_type_code, name, type, units, amount, billing_frequency, status,
            enrollment_status, mandatory, validity_days, one_time_purchase, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'System')`,
        s,
      );
    }
  }
};

exports.down = async () => {};
