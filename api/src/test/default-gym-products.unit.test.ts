// #1149: the gate over the default Product catalogue a new gym receives.
//
// It is a unit test because everything it asserts is decided before a gym
// exists: the seven defaults and their configuration, that each one names a
// `charge_types` row the catalogue actually seeds (or declares itself as the
// one System Product with no charge type), that no default is written on a
// frequency a Product may no longer be configured with (#945), and that the
// two gym-creation paths go through the one seeder rather than spelling an
// INSERT of their own.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GYM_PRODUCTS,
  SYSTEM_PT_PACKAGE_NAME,
  defaultProductForChargeType,
  defaultProductsWithoutChargeType,
} from '../domain/defaultGymProducts';
import { OFFERED_PRODUCT_FREQUENCIES } from '../domain/productFrequency';

const SRC = path.join(__dirname, '..');
const read = (rel: string) => readFileSync(path.join(SRC, rel), 'utf8');

/** #1149's table, as the ticket writes it. */
const TICKET_TABLE = [
  ['Access Key', 'fee', null, 5, 'once', 'inactive', 'staff_only', false],
  ['Insurance Fee', 'fee', null, 20, 'year', 'active', 'staff_only', true],
  ['Locker Rental', 'fee', null, 15, 'month', 'active', 'public', false],
  ['Parking Fee', 'fee', null, 30, 'month', 'inactive', 'public', false],
  ['Personal Training Class Package (10 Sessions)', 'sessions', 10, 500, 'once', 'active', 'public', false],
  ['Premium Fitness App', 'fee', null, null, 'once', 'inactive', 'staff_only', false],
  ['Registration Fee', 'fee', null, 100, 'once', 'active', 'staff_only', true],
] as const;

describe('#1149 default gym Products — the declaration', () => {
  it('declares exactly the seven Products the ticket lists, with its configuration', () => {
    expect(DEFAULT_GYM_PRODUCTS).toHaveLength(TICKET_TABLE.length);
    for (const [name, type, units, amount, frequency, status, enrollment, mandatory] of TICKET_TABLE) {
      const declared = DEFAULT_GYM_PRODUCTS.find((p) => p.name === name);
      expect(declared, `no default declared for ${name}`).toBeDefined();
      expect(declared).toMatchObject({
        type,
        units,
        amount,
        billingFrequency: frequency,
        status,
        enrollmentStatus: enrollment,
        mandatory,
      });
    }
  });

  // §2: the Mandatory pair, and nothing else. A third mandatory default would
  // silently join every Membership Plan benefit section of every new gym
  // (#832/#893).
  it('marks Insurance Fee and Registration Fee mandatory, and only those two', () => {
    const mandatory = DEFAULT_GYM_PRODUCTS.filter((p) => p.mandatory).map((p) => p.name).sort();
    expect(mandatory).toEqual(['Insurance Fee', 'Registration Fee']);
  });

  // #945: what may be *stored* is wider than what may be *configured*, and a
  // default is created by the product rather than kept from a legacy row — so
  // a retired frequency here would be a typo nothing else could catch.
  it('uses only frequencies a Product may still be configured with', () => {
    for (const product of DEFAULT_GYM_PRODUCTS) {
      expect(OFFERED_PRODUCT_FREQUENCIES).toContain(product.billingFrequency);
    }
  });

  it('keys each default on a distinct charge type, with the PT package the one row without', () => {
    const codes = DEFAULT_GYM_PRODUCTS.map((p) => p.chargeTypeCode).filter((c): c is string => c !== null);
    expect(new Set(codes).size).toBe(codes.length);
    expect(defaultProductsWithoutChargeType().map((p) => p.name)).toEqual([SYSTEM_PT_PACKAGE_NAME]);
    expect(defaultProductForChargeType('locker_rental')?.name).toBe('Locker Rental');
    expect(defaultProductForChargeType('membership_fee')).toBeUndefined();
  });

  // #543: a System Product's name comes from `charge_types`, so a declared
  // code that the catalogue does not seed would configure nothing, and a name
  // that disagrees with the catalogue's would describe the wrong row.
  it('names charge types the catalogue actually seeds as Products', () => {
    const seed = readFileSync(
      path.join(SRC, 'infra/migrations/090_gym_charges.js'),
      'utf8',
    );
    for (const product of DEFAULT_GYM_PRODUCTS) {
      if (product.chargeTypeCode === null) continue;
      expect(seed, `charge type ${product.chargeTypeCode} is not seeded by migration 090`)
        .toContain(`code: '${product.chargeTypeCode}'`);
      expect(seed, `charge type ${product.chargeTypeCode} is not named ${product.name}`)
        .toContain(`name: '${product.name}'`);
    }
  });

  // §"use the existing Product creation/setup mechanisms rather than
  // introducing a separate hardcoded Product implementation".
  it('leaves both gym-creation paths with one seeder call and no INSERT of their own', () => {
    const gyms = read('api/gyms.ts');
    expect(gyms.match(/seedDefaultGymProducts\(/g) ?? []).toHaveLength(2);
    expect(gyms).not.toMatch(/INSERT\s+(IGNORE\s+)?INTO\s+products/i);
  });

  // The prices are stored VAT-inclusive of the gym's own system rate, so the
  // rate has to exist before the Products are written.
  it('seeds the gym system tax rate before the Products in both paths', () => {
    const gyms = read('api/gyms.ts');
    let from = 0;
    for (let i = 0; i < 2; i += 1) {
      const taxAt = gyms.indexOf("'Standard VAT'", from);
      const seedAt = gyms.indexOf('seedDefaultGymProducts(', from);
      expect(taxAt).toBeGreaterThan(-1);
      expect(seedAt).toBeGreaterThan(taxAt);
      from = seedAt + 1;
    }
  });
});

// #1349: the One-time pair, and nothing else, independent of frequency.
describe('#1349 one-time purchase flag', () => {
  it('flags Premium Fitness App and Registration Fee only', () => {
    const flagged = DEFAULT_GYM_PRODUCTS.filter((p) => p.oneTimePurchase).map((p) => p.name).sort();
    expect(flagged).toEqual(['Premium Fitness App', 'Registration Fee']);
  });

  it('does not derive the flag from a Once frequency', () => {
    const onceUnflagged = DEFAULT_GYM_PRODUCTS.filter((p) => p.billingFrequency === 'once' && !p.oneTimePurchase);
    expect(onceUnflagged.length).toBeGreaterThan(0);
  });

  it('the seeder writes the column', () => {
    expect(read('api/gym-default-products.ts')).toContain('one_time_purchase');
  });
});
