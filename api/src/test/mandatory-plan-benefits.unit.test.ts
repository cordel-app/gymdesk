// #893 — Mandatory Products are always part of a Membership Plan.
//
// Unit tests: `domain/mandatoryPlanBenefits.ts` is pure (no DB, no HTTP), so per
// CLAUDE.md it is exercised directly — no `createTestGym`, no `db.end()`. The
// router half (the `GET` that reports a missing mandatory item and the `PUT`
// that cannot be made to drop one) is covered in
// `membership-plan-benefits.test.ts`, against the real Express + MySQL stack.

import { describe, expect, it } from 'vitest';
import {
  MANDATORY_BENEFIT_QUANTITY,
  MandatoryProduct,
  PlanBenefitRow,
  isMandatoryProduct,
  mandatoryItemsForCategory,
  mergeMandatoryBenefits,
  withMandatoryBenefits,
} from '../domain/mandatoryPlanBenefits';

function item(
  over: Partial<MandatoryProduct> & { id: number; name: string },
): MandatoryProduct {
  return {
    type: 'fee', billing_frequency: null, status: 'active', mandatory: 1, ...over,
  };
}

function row(over: Partial<PlanBenefitRow> & { gym_charge_id: number }): PlanBenefitRow {
  return {
    quantity: 1, gym_charge_name: `Item ${over.gym_charge_id}`, gym_charge_type: 'fee',
    gym_charge_billing_frequency: null, gym_charge_status: 'active', gym_charge_mandatory: 0,
    ...over,
  };
}

describe('isMandatoryProduct', () => {
  it('reads both a tinyint and a boolean', () => {
    expect(isMandatoryProduct({ mandatory: 1 })).toBe(true);
    expect(isMandatoryProduct({ mandatory: true })).toBe(true);
    expect(isMandatoryProduct({ mandatory: 0 })).toBe(false);
    expect(isMandatoryProduct({ mandatory: false })).toBe(false);
  });
});

describe('mandatoryItemsForCategory', () => {
  // The classification is `classifyProduct()` and nothing else (#550), so a
  // mandatory item can never be forced into a section it does not belong to.
  const candidates = [
    item({ id: 1, name: 'Insurance Fee', type: 'fee', billing_frequency: 'year' }),   // periodical
    item({ id: 2, name: 'Registration Fee', type: 'fee', billing_frequency: 'once' }), // oneoff
    item({ id: 3, name: 'PT Pack', type: 'sessions', billing_frequency: 'once' }),     // session
    item({ id: 4, name: 'Locker', type: 'fee', billing_frequency: 'month', mandatory: 0 }),
  ];

  it('keeps only the mandatory items of that category', () => {
    expect(mandatoryItemsForCategory(candidates, 'periodical').map((i) => i.id)).toEqual([1]);
    expect(mandatoryItemsForCategory(candidates, 'oneoff').map((i) => i.id)).toEqual([2]);
    expect(mandatoryItemsForCategory(candidates, 'session').map((i) => i.id)).toEqual([3]);
  });

  it('never returns a non-mandatory item, whatever its category', () => {
    const all = (['session', 'oneoff', 'periodical'] as const)
      .flatMap((c) => mandatoryItemsForCategory(candidates, c).map((i) => i.id));
    expect(all).not.toContain(4);
  });

  it('counts a legacy weekly frequency as periodical, like every other reader', () => {
    // `week` is retired but not deleted (#821) — a legacy item still classifies
    // as `periodical`, so a mandatory one belongs in Period Benefits.
    const legacy = [item({ id: 9, name: 'Weekly Fee', type: 'fee', billing_frequency: 'week' })];
    expect(mandatoryItemsForCategory(legacy, 'periodical').map((i) => i.id)).toEqual([9]);
  });
});

describe('mergeMandatoryBenefits', () => {
  const insurance = item({ id: 1, name: 'Insurance Fee', type: 'fee', billing_frequency: 'year' });

  it('adds a mandatory item the Plan has no row for, at the default quantity', () => {
    const merged = mergeMandatoryBenefits([row({ gym_charge_id: 7 })], [insurance]);
    expect(merged.map((r) => r.gym_charge_id)).toEqual([7, 1]);
    const added = merged[1];
    expect(added.quantity).toBe(MANDATORY_BENEFIT_QUANTITY);
    expect(added.implicit).toBe(true);
    expect(added.gym_charge_mandatory).toBe(1);
    expect(added.gym_charge_name).toBe('Insurance Fee');
    expect(added.gym_charge_billing_frequency).toBe('year');
  });

  it('does not duplicate an item the Plan already carries (§8)', () => {
    const stored = [row({ gym_charge_id: 1, quantity: 4, gym_charge_mandatory: 1 })];
    const merged = mergeMandatoryBenefits(stored, [insurance]);
    expect(merged).toHaveLength(1);
    // §4: mandatory says the item must exist, never what its quantity is.
    expect(merged[0].quantity).toBe(4);
    expect(merged[0].implicit).toBeUndefined();
  });

  it('compares ids numerically — a string id from the driver still matches', () => {
    const stored = [row({ gym_charge_id: '1' as unknown as number })];
    expect(mergeMandatoryBenefits(stored, [insurance])).toHaveLength(1);
  });

  it('leaves the stored rows alone, and their order, when nothing is mandatory', () => {
    const stored = [row({ gym_charge_id: 5 }), row({ gym_charge_id: 3 })];
    expect(mergeMandatoryBenefits(stored, []).map((r) => r.gym_charge_id)).toEqual([5, 3]);
  });

  it('is the whole section for a Plan with no rows at all', () => {
    expect(mergeMandatoryBenefits([], [insurance]).map((r) => r.gym_charge_id)).toEqual([1]);
  });
});

describe('withMandatoryBenefits', () => {
  const insurance = item({ id: 1, name: 'Insurance Fee', type: 'fee', billing_frequency: 'year' });

  it('re-adds a mandatory item the client dropped (§7)', () => {
    expect(withMandatoryBenefits([{ gym_charge_id: 7, quantity: 2 }], [insurance])).toEqual([
      { gym_charge_id: 7, quantity: 2 },
      { gym_charge_id: 1, quantity: MANDATORY_BENEFIT_QUANTITY },
    ]);
  });

  it('passes a submitted mandatory item through untouched, quantity included (§4)', () => {
    expect(withMandatoryBenefits([{ gym_charge_id: 1, quantity: 12 }], [insurance])).toEqual([
      { gym_charge_id: 1, quantity: 12 },
    ]);
  });

  it('turns an empty save into the mandatory items alone, never an empty section', () => {
    expect(withMandatoryBenefits([], [insurance])).toEqual([
      { gym_charge_id: 1, quantity: MANDATORY_BENEFIT_QUANTITY },
    ]);
  });

  it('changes nothing when the gym has no mandatory items', () => {
    const submitted = [{ gym_charge_id: 7, quantity: 2 }];
    expect(withMandatoryBenefits(submitted, [])).toEqual(submitted);
  });
});
