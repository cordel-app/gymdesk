/**
 * #896 stage 1 — the per-context option sets and the value rules, plus the
 * "two places" guard: the lists in `domain/sellableItemBenefitActions.ts` and
 * the CHECK sets migration 203 writes have to say the same thing, or a Plan
 * could be offered an action its own table refuses.
 *
 * Pure module, no DB (CLAUDE.md): the migration is read as a module and its
 * exported lists/expression are compared, the way
 * `migration-191-negotiated-fee.unit.test.ts` reads back its WHERE fragments.
 */

import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_BENEFIT_ACTION,
  MAX_BENEFIT_AMOUNT,
  NO_SELLABLE_ITEM_BENEFIT,
  PLAN_BENEFIT_ACTIONS,
  PROMOTION_ITEM_ACTIONS,
  applyLineBenefit,
  benefitActionRequiresValue,
  benefitActionsFor,
  benefitConfigError,
  isBenefitActionAllowed,
  toSellableItemBenefit,
} from '../domain/sellableItemBenefitActions';

const require = createRequire(__filename);
const migration = require('../infra/migrations/203_sellable_item_benefit_actions.js') as {
  PROMOTION_ACTIONS: string[];
  PLAN_ACTIONS: string[];
  PROMOTION_TABLES: string[];
  PLAN_TABLES: string[];
  DEFAULT_ACTION: string;
  BACKFILL_ACTION: { promotion: string; plan: string };
  valueCheckExpression: (actions: string[]) => string;
};

describe('#896 — the two option sets', () => {
  it('offers a Promotion exactly the five actions of §2, in dropdown order', () => {
    expect(PROMOTION_ITEM_ACTIONS).toEqual([
      'no_benefit', 'waive', 'percentage_discount', 'fixed_discount', 'fixed_price',
    ]);
  });

  it('offers a Membership Plan three — §16: it cannot configure Fixed discount or Fixed Price', () => {
    expect(PLAN_BENEFIT_ACTIONS).toEqual(['no_benefit', 'waive', 'percentage_discount']);
    expect(PLAN_BENEFIT_ACTIONS).not.toContain('fixed_discount');
    expect(PLAN_BENEFIT_ACTIONS).not.toContain('fixed_price');
  });

  it('is one vocabulary — every Plan action is also a Promotion action', () => {
    // The stored value is shared (`PromotionBenefitAction`); only the labels
    // differ by context. A Plan-only value would make the two incomparable.
    for (const action of PLAN_BENEFIT_ACTIONS) {
      expect(PROMOTION_ITEM_ACTIONS).toContain(action);
    }
  });

  it('resolves the set by context, and gates membership on it', () => {
    expect(benefitActionsFor('promotion')).toBe(PROMOTION_ITEM_ACTIONS);
    expect(benefitActionsFor('plan')).toBe(PLAN_BENEFIT_ACTIONS);
    expect(isBenefitActionAllowed('promotion', 'fixed_price')).toBe(true);
    expect(isBenefitActionAllowed('plan', 'fixed_price')).toBe(false);
    expect(isBenefitActionAllowed('plan', 'percentage_discount')).toBe(true);
    expect(isBenefitActionAllowed('promotion', 'free_forever')).toBe(false);
    expect(isBenefitActionAllowed('promotion', null)).toBe(false);
  });

  it('starts neutral — §13, so nothing becomes discounted by the column existing', () => {
    expect(DEFAULT_BENEFIT_ACTION).toBe('no_benefit');
    expect(NO_SELLABLE_ITEM_BENEFIT).toEqual({ action: 'no_benefit', value: null });
  });
});

describe('#896 — which actions take a value (§6)', () => {
  it('asks for one for the three that configure a number', () => {
    expect(benefitActionRequiresValue('percentage_discount')).toBe(true);
    expect(benefitActionRequiresValue('fixed_discount')).toBe(true);
    expect(benefitActionRequiresValue('fixed_price')).toBe(true);
  });

  it('asks for none for the two that are complete on their own', () => {
    expect(benefitActionRequiresValue('no_benefit')).toBe(false);
    expect(benefitActionRequiresValue('waive')).toBe(false);
  });
});

describe('#896 — benefitConfigError (the backend half of §6)', () => {
  it('accepts a complete pair', () => {
    expect(benefitConfigError('promotion', 'no_benefit', null)).toBeNull();
    expect(benefitConfigError('promotion', 'waive', undefined)).toBeNull();
    expect(benefitConfigError('promotion', 'percentage_discount', 20)).toBeNull();
    expect(benefitConfigError('promotion', 'fixed_discount', 10)).toBeNull();
    expect(benefitConfigError('promotion', 'fixed_price', 20)).toBeNull();
    expect(benefitConfigError('plan', 'percentage_discount', 0)).toBeNull();
    expect(benefitConfigError('plan', 'percentage_discount', 100)).toBeNull();
  });

  it('rejects a value-requiring action with nothing to apply', () => {
    for (const action of ['percentage_discount', 'fixed_discount', 'fixed_price']) {
      expect(benefitConfigError('promotion', action, null)).toContain('requires a value');
      expect(benefitConfigError('promotion', action, '')).toContain('requires a value');
    }
  });

  it('rejects a value on an action that takes none — only the selected option is submitted', () => {
    expect(benefitConfigError('promotion', 'no_benefit', 20)).toContain('takes no value');
    expect(benefitConfigError('plan', 'waive', 0)).toContain('takes no value');
  });

  it('holds a percentage to 0..100 and an amount to non-negative', () => {
    expect(benefitConfigError('promotion', 'percentage_discount', 101)).toContain('between 0 and 100');
    expect(benefitConfigError('promotion', 'percentage_discount', -1)).toContain('between 0 and 100');
    expect(benefitConfigError('promotion', 'fixed_discount', -0.01)).toContain('must not be negative');
    expect(benefitConfigError('promotion', 'fixed_price', MAX_BENEFIT_AMOUNT + 1)).toContain('must not exceed');
    expect(benefitConfigError('promotion', 'percentage_discount', 'twenty')).toContain('numeric');
  });

  it('refuses a Plan the two monetary actions, by name', () => {
    const err = benefitConfigError('plan', 'fixed_price', 20);
    expect(err).toBe('action must be one of: no_benefit, waive, percentage_discount');
    expect(benefitConfigError('plan', 'fixed_discount', 10)).toBe(err);
  });
});

describe('#896 — reading a stored pair back', () => {
  it('normalizes a valid pair', () => {
    expect(toSellableItemBenefit('promotion', 'percentage_discount', '20')).toEqual({
      action: 'percentage_discount', value: 20,
    });
    expect(toSellableItemBenefit('promotion', 'waive', 5)).toEqual({ action: 'waive', value: null });
  });

  it('falls back to the neutral default rather than inventing a discount', () => {
    // A row written between migration 203's two statements, a value that went
    // missing, or an action a later ticket removed: none of them may price to
    // less than the normal price.
    expect(toSellableItemBenefit('promotion', null, null)).toEqual(NO_SELLABLE_ITEM_BENEFIT);
    expect(toSellableItemBenefit('promotion', 'percentage_discount', null)).toEqual(NO_SELLABLE_ITEM_BENEFIT);
    expect(toSellableItemBenefit('promotion', 'fixed_price', 'abc')).toEqual(NO_SELLABLE_ITEM_BENEFIT);
    expect(toSellableItemBenefit('promotion', 'percentage_discount', -5)).toEqual(NO_SELLABLE_ITEM_BENEFIT);
  });

  it('clamps rather than trusts, and respects the context', () => {
    expect(toSellableItemBenefit('promotion', 'percentage_discount', 150)).toEqual({
      action: 'percentage_discount', value: 100,
    });
    // A `fixed_price` somehow stored on a Plan row reads as neutral, whatever
    // the column says — the context decides, not the data.
    expect(toSellableItemBenefit('plan', 'fixed_price', 20)).toEqual(NO_SELLABLE_ITEM_BENEFIT);
  });
});

describe('#896 — applyLineBenefit (the Q2 answer: the line, not the unit)', () => {
  it('charges the whole line when there is no treatment', () => {
    expect(applyLineBenefit(10, 10, null)).toBe(100);
    expect(applyLineBenefit(10, 10, { action: 'no_benefit', value: null })).toBe(100);
  });

  it('waives the line entirely', () => {
    expect(applyLineBenefit(10, 10, { action: 'waive', value: null })).toBe(0);
  });

  it('applies a percentage to price × quantity', () => {
    expect(applyLineBenefit(10, 10, { action: 'percentage_discount', value: 20 })).toBe(80);
  });

  it('applies a fixed discount and a fixed price per line, not per unit', () => {
    // "Fixed ammount or Fixed discount apply per line" — the #896 thread.
    expect(applyLineBenefit(10, 10, { action: 'fixed_discount', value: 15 })).toBe(85);
    expect(applyLineBenefit(10, 10, { action: 'fixed_price', value: 20 })).toBe(20);
  });

  it('never goes negative, and treats a nonsense quantity as zero', () => {
    expect(applyLineBenefit(10, 1, { action: 'fixed_discount', value: 999 })).toBe(0);
    expect(applyLineBenefit(10, Number.NaN, { action: 'no_benefit', value: null })).toBe(0);
    expect(applyLineBenefit(10, -3, { action: 'percentage_discount', value: 10 })).toBe(0);
  });
});

describe('#896 — migration 203 says the same thing as the module', () => {
  it('permits exactly the module\'s actions on each side', () => {
    expect(migration.PROMOTION_ACTIONS).toEqual([...PROMOTION_ITEM_ACTIONS]);
    expect(migration.PLAN_ACTIONS).toEqual([...PLAN_BENEFIT_ACTIONS]);
  });

  it('defaults new rows to the module\'s neutral action', () => {
    expect(migration.DEFAULT_ACTION).toBe(DEFAULT_BENEFIT_ACTION);
  });

  it('backfills a Promotion grant to waive and a Plan benefit to the default (§13)', () => {
    // A Promotion grant is an implicit waive today; a Plan benefit is charged
    // at its own price. Backfilling the promotion side to `no_benefit` would
    // start charging for items a member gets free.
    expect(migration.BACKFILL_ACTION.promotion).toBe('waive');
    expect(migration.BACKFILL_ACTION.plan).toBe(DEFAULT_BENEFIT_ACTION);
    expect(PROMOTION_ITEM_ACTIONS).toContain(migration.BACKFILL_ACTION.promotion);
    expect(PLAN_BENEFIT_ACTIONS).toContain(migration.BACKFILL_ACTION.plan);
  });

  it('touches the twelve relationship tables and nothing else (§12)', () => {
    expect(migration.PROMOTION_TABLES).toEqual([
      'promotion_session',
      'promotion_oneoff',
      'promotion_periodical',
      'user_membership_promotion_session_snapshot',
      'user_membership_promotion_oneoff_snapshot',
      'user_membership_promotion_periodical_snapshot',
    ]);
    expect(migration.PLAN_TABLES).toEqual([
      'membership_plan_session',
      'membership_plan_oneoff',
      'membership_plan_periodical',
      'user_membership_session',
      'user_membership_oneoff',
      'user_membership_periodical',
    ]);
    // §12: the global Sellable Item is not one of them.
    for (const table of [...migration.PROMOTION_TABLES, ...migration.PLAN_TABLES]) {
      expect(table).not.toBe('gym_charges');
    }
  });

  it('writes a CHECK that mirrors benefitConfigError, per context', () => {
    const promotion = migration.valueCheckExpression(migration.PROMOTION_ACTIONS);
    expect(promotion).toContain("`action` IN ('no_benefit', 'waive') AND `value` IS NULL");
    expect(promotion).toContain('`value` >= 0 AND `value` <= 100');
    expect(promotion).toContain("`action` IN ('fixed_discount', 'fixed_price') AND `value` IS NOT NULL");

    // The Plan side never mentions the two actions its action CHECK refuses.
    const plan = migration.valueCheckExpression(migration.PLAN_ACTIONS);
    expect(plan).not.toContain('fixed_discount');
    expect(plan).not.toContain('fixed_price');
  });

  it('keeps every constraint name inside MySQL\'s 64-character identifier limit', () => {
    // The snapshot tables are the ones migration 156 had to invent short FK
    // prefixes for, so this is not theoretical.
    for (const table of [...migration.PROMOTION_TABLES, ...migration.PLAN_TABLES]) {
      expect(`chk_${table}_action`.length).toBeLessThanOrEqual(64);
      expect(`chk_${table}_value`.length).toBeLessThanOrEqual(64);
    }
  });

  it('bounds the amount at what DECIMAL(10,2) holds', () => {
    // The CHECK bounds the value from below only; the column is the upper
    // bound, and `MAX_BENEFIT_AMOUNT` is that same limit spelled out so the
    // API answers 400 rather than letting MySQL raise an out-of-range error.
    expect(MAX_BENEFIT_AMOUNT).toBe(10 ** 8 - 0.01);
  });
});
