// #926: what a Promotion applies to — a Membership Plan or a Product.
// Pure module, no DB and no HTTP.
//
// The value crosses the wire four ways, so this file asserts all four agree:
// the accepted set here, the radio group's mirror in
// `apps/admin/src/lib/promotionTargets.ts`, the `applies_to_<target>` locale
// keys the mirror interpolates (next-intl prints a missing key verbatim), and
// the set `chk_promotions_applies_to` admits — which the migration that last
// defined it exports for exactly this reason, as migration 203 exports its own
// action sets. Without that last assertion a third target added here and to the
// mirror would pass every test and surface as a 500 from the database on save.
//
// Since #949 stage 3 that migration is **214**, not 204: the stored value moved
// with the entity's name and 214 rebuilt the CHECK around the new set, so
// reading 204's exported set here would assert against a constraint the
// database no longer has.

import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PROMOTION_TARGET,
  PROMOTION_TARGETS,
  describePromotionTargets,
  isPromotionTarget,
  targetsMembershipPlan,
} from '../domain/promotionTarget';

const migration = createRequire(__filename)('../infra/migrations/214_rename_products.js') as {
  TARGETS: string[];
  TARGET_CHECK: string;
};

const ADMIN_SRC = join(__dirname, '..', '..', '..', 'apps', 'admin', 'src', 'lib', 'promotionTargets.ts');
const LOCALES = ['en', 'es', 'ca'] as const;

describe('PROMOTION_TARGETS', () => {
  it('is exactly the two targets, in the order the radio group lists them', () => {
    expect(PROMOTION_TARGETS).toEqual(['membership_plan', 'product']);
  });

  it('defaults to the Membership Plan behaviour every Promotion had before #926', () => {
    expect(DEFAULT_PROMOTION_TARGET).toBe('membership_plan');
    expect(PROMOTION_TARGETS).toContain(DEFAULT_PROMOTION_TARGET);
  });

  it('rejects anything else', () => {
    for (const junk of ['plan', 'products', 'MEMBERSHIP_PLAN', '', null, undefined, 1, {}, ['membership_plan']]) {
      expect(isPromotionTarget(junk)).toBe(false);
    }
  });

  it('names the accepted set for the 400 message', () => {
    expect(describePromotionTargets()).toBe('membership_plan, product');
  });
});

describe('migration 214\'s CHECK', () => {
  it('admits exactly the targets this module accepts, in the same order', () => {
    expect(migration.TARGETS).toEqual([...PROMOTION_TARGETS]);
  });

  it('is the constraint the router\'s 400 keeps the database from having to answer', () => {
    expect(migration.TARGET_CHECK).toBe('chk_promotions_applies_to');
  });
});

describe('targetsMembershipPlan', () => {
  it('is true for the Plan target and false for the Product one', () => {
    expect(targetsMembershipPlan('membership_plan')).toBe(true);
    expect(targetsMembershipPlan('product')).toBe(false);
  });

  it('treats an unknown or missing target as the default, never as "no Plan"', () => {
    // A row read before migration 204 reached it, or a client that never names
    // the column: the Membership Fee Benefit and Suitable Membership Plans
    // sections have to stay visible, not disappear.
    for (const absent of [null, undefined, '', 'nonsense']) {
      expect(targetsMembershipPlan(absent)).toBe(true);
    }
  });
});

describe('the admin mirror', () => {
  const adminSrc = readFileSync(ADMIN_SRC, 'utf-8');
  const options = [...adminSrc.matchAll(/\{ value: '(\w+)', labelKey: '(\w+)' \}/g)]
    .map((m) => ({ value: m[1], labelKey: m[2] }));

  it('offers exactly the targets the API accepts, in the same order', () => {
    expect(options.length).toBeGreaterThan(0);
    expect(options.map((o) => o.value)).toEqual([...PROMOTION_TARGETS]);
  });

  it('declares the same default', () => {
    expect(adminSrc).toContain(`DEFAULT_PROMOTION_TARGET: PromotionTarget = '${DEFAULT_PROMOTION_TARGET}'`);
  });

  it('labels each target with a key that exists in every locale', () => {
    for (const locale of LOCALES) {
      const messages = JSON.parse(
        readFileSync(join(__dirname, '..', '..', '..', 'apps', 'admin', 'locales', 'base', `${locale}.json`), 'utf-8'),
      );
      for (const { labelKey } of options) {
        expect(messages.promotions?.[labelKey], `${locale}: promotions.${labelKey}`).toBeTruthy();
      }
      // The section heading and the Details row the same value is shown in.
      expect(messages.promotions?.section_applies_to, `${locale}: promotions.section_applies_to`).toBeTruthy();
      expect(messages.promotions?.detail_applies_to, `${locale}: promotions.detail_applies_to`).toBeTruthy();
    }
  });
});
