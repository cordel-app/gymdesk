// #1149: the Products a gym starts with.
//
// A gym has never been created empty-handed — `POST /gyms` has seeded one
// `products` row per `charge_types.is_product` entry since #543, and the
// Personal Training package since #371 (migration 124). What it seeded was a
// **name and a type and nothing else**: no price, no billing frequency, no
// tax rate, and the column defaults for everything else, so every new gym
// opened its Products page onto seven rows reading `—` and had to configure
// each one by hand. This module is the configuration those rows should have
// been written with, declared once.
//
// Four of its answers are the rule rather than the implementation.
//
//  - **It is a default, never a correction.** Seeding is idempotent and only
//    ever INSERTs: a row that exists is left exactly as it is, so re-running
//    the initialization of a gym whose staff have since repriced the Locker
//    Rental cannot overwrite them (§7), and **no existing gym is touched at
//    all** (§8) — there is no migration and no backfill, which is why this is
//    a module beside the two creation paths rather than a data migration.
//  - **A System Product is still seeded from `charge_types`.** `code` is the
//    key and the row's `name` keeps coming from the catalogue (#543's rule, as
//    does `charge_type_id`), so this declaration carries what the catalogue
//    cannot — the price, the frequency, the two statuses and `mandatory` — and
//    not a second spelling of what it can. `name` below is the *expected*
//    catalogue name: it documents the table in the ticket and is what the unit
//    test asserts the seed list against, never what is written.
//  - **A charge type with no entry here still seeds**, exactly as it did
//    before: name and type and the column defaults. A seventh `is_product`
//    charge type added tomorrow is a Product of the gym's on the day it ships,
//    and `products` would otherwise simply not have a row for it.
//  - **The prices are VAT-inclusive** (§5), which is what `tax_behavior =
//    'inclusive'` means on this table and what every existing seeded row
//    already stores; the rate is the gym's own system tax rate, the `Standard
//    VAT` 21% row seeded beside the products and the one `selectPlanTaxRates()`
//    (#817) calls the gym default. A deployment whose gym somehow has none
//    gets `tax_rate_id = NULL` rather than a seed failure — the figure is
//    still the price the gym charges.
//
// Adding a default goes in **one** place: this list. Changing one changes what
// the *next* gym is created with and nothing else.

import { type OfferedProductFrequency } from './productFrequency';

/**
 * The Personal Training package's name, as #371 and migration 124 spell it.
 * It is the idempotency key for that row, which has no `charge_type_id` to be
 * keyed on — the guard `POST /gyms` has used for it since #371.
 */
export const SYSTEM_PT_PACKAGE_NAME = 'Personal Training Class Package (10 Sessions)';

export type DefaultGymProduct = {
  /**
   * The `charge_types.code` this Product is seeded from, or `null` for a
   * System Product that has no charge type (`products.charge_type_id` is
   * nullable since migration 102 — the Personal Training package is the one
   * such row, as migration 124 wrote it).
   */
  chargeTypeCode: string | null;
  /**
   * For a charge-type-backed row, the catalogue name this entry is expected to
   * match — documentation and a test fixture, never what is inserted (the
   * insert reads `charge_types.name`). For a row with no charge type it *is*
   * the name, and the idempotency guard is keyed on it.
   */
  name: string;
  type: 'fee' | 'sessions';
  /** A Sessions package's size. `products.amount` prices the whole of it (#942). */
  units: number | null;
  /** VAT-inclusive euros, or `null` for a Product the gym must price itself. */
  amount: number | null;
  billingFrequency: OfferedProductFrequency;
  status: 'active' | 'inactive';
  enrollmentStatus: 'public' | 'staff_only';
  /** #832: part of every Membership Plan benefit section while set. */
  mandatory: boolean;
  /** #371: 6 calendar months, as migration 124 approximated them. */
  validityDays: number | null;
};

/**
 * The seven Products a newly created gym receives, in the order #1149's table
 * lists them (which is the Products page's own ordering, by name).
 */
export const DEFAULT_GYM_PRODUCTS: readonly DefaultGymProduct[] = [
  {
    chargeTypeCode: 'access_key',
    name: 'Access Key',
    type: 'fee',
    units: null,
    amount: 5,
    billingFrequency: 'once',
    status: 'inactive',
    enrollmentStatus: 'staff_only',
    mandatory: false,
    validityDays: null,
  },
  {
    chargeTypeCode: 'insurance_fee',
    name: 'Insurance Fee',
    type: 'fee',
    units: null,
    amount: 20,
    billingFrequency: 'year',
    status: 'active',
    enrollmentStatus: 'staff_only',
    mandatory: true,
    validityDays: null,
  },
  {
    chargeTypeCode: 'locker_rental',
    name: 'Locker Rental',
    type: 'fee',
    units: null,
    amount: 15,
    billingFrequency: 'month',
    status: 'active',
    enrollmentStatus: 'public',
    mandatory: false,
    validityDays: null,
  },
  {
    chargeTypeCode: 'parking_fee',
    name: 'Parking Fee',
    type: 'fee',
    units: null,
    amount: 30,
    billingFrequency: 'month',
    status: 'inactive',
    enrollmentStatus: 'public',
    mandatory: false,
    validityDays: null,
  },
  {
    // #371 / migration 124: the one System Product with no charge type.
    chargeTypeCode: null,
    name: SYSTEM_PT_PACKAGE_NAME,
    type: 'sessions',
    units: 10,
    amount: 500,
    billingFrequency: 'once',
    status: 'active',
    enrollmentStatus: 'public',
    mandatory: false,
    validityDays: 182,
  },
  {
    chargeTypeCode: 'premium_fitness_app',
    name: 'Premium Fitness App',
    type: 'fee',
    // §5: created without a price. `null` reads as `—`, never €0.00.
    units: null,
    amount: null,
    billingFrequency: 'once',
    status: 'inactive',
    enrollmentStatus: 'staff_only',
    mandatory: false,
    validityDays: null,
  },
  {
    chargeTypeCode: 'registration_fee',
    name: 'Registration Fee',
    type: 'fee',
    units: null,
    amount: 100,
    billingFrequency: 'once',
    status: 'active',
    enrollmentStatus: 'staff_only',
    mandatory: true,
    validityDays: null,
  },
];

/** The defaults for a charge type, or `undefined` when none is declared. */
export function defaultProductForChargeType(code: string): DefaultGymProduct | undefined {
  return DEFAULT_GYM_PRODUCTS.find((p) => p.chargeTypeCode === code);
}

/** The defaults that are not seeded from `charge_types` (the PT package). */
export function defaultProductsWithoutChargeType(): readonly DefaultGymProduct[] {
  return DEFAULT_GYM_PRODUCTS.filter((p) => p.chargeTypeCode === null);
}
