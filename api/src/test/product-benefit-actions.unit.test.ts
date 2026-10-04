/**
 * #896 stage 1 — the per-context option sets and the value rules, plus the
 * "two places" guard: the lists in `domain/productBenefitActions.ts` and
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
  NO_PRODUCT_BENEFIT,
  LEGACY_PLAN_BENEFIT_ACTIONS,
  PLAN_BENEFIT_ACTIONS,
  PROMOTION_ITEM_ACTIONS,
  STORED_PLAN_BENEFIT_ACTIONS,
  applyLineBenefit,
  benefitActionRequiresValue,
  benefitActionsFor,
  benefitConfigError,
  isBenefitActionAllowed,
  isRetiredBenefitAction,
  isStoredBenefitAction,
  keepsRetiredBenefit,
  parseProductBenefitInput,
  storedBenefitActionsFor,
  shapeProductBenefitRow,
  toProductBenefit,
} from '../domain/productBenefitActions';
import {
  MANDATORY_BENEFIT_QUANTITY,
  mergeMandatoryBenefits,
  withMandatoryBenefits,
} from '../domain/mandatoryPlanBenefits';

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

  it('offers a Membership Plan two — §16, and #997 for the third', () => {
    // §16 keeps `Fixed discount` and `Fixed Price` out; #997 retired
    // `% Discount` as well, so a Plan benefit is either charged at the
    // Product's own price or waived.
    expect(PLAN_BENEFIT_ACTIONS).toEqual(['no_benefit', 'waive']);
    expect(PLAN_BENEFIT_ACTIONS).not.toContain('percentage_discount');
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
    expect(isBenefitActionAllowed('plan', 'percentage_discount')).toBe(false);
    expect(isBenefitActionAllowed('promotion', 'free_forever')).toBe(false);
    expect(isBenefitActionAllowed('promotion', null)).toBe(false);
  });

  it('starts neutral — §13, so nothing becomes discounted by the column existing', () => {
    expect(DEFAULT_BENEFIT_ACTION).toBe('no_benefit');
    expect(NO_PRODUCT_BENEFIT).toEqual({ action: 'no_benefit', value: null });
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
    // A Plan's percentage is #997's retired case, exercised below — it is valid
    // only as the pair the line already stores.
    expect(benefitConfigError('plan', 'percentage_discount', 20,
      { action: 'percentage_discount', value: 20 })).toBeNull();
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
    expect(err).toBe('action must be one of: no_benefit, waive');
    expect(benefitConfigError('plan', 'fixed_discount', 10)).toBe(err);
  });
});

describe('#896 — reading a stored pair back', () => {
  it('normalizes a valid pair', () => {
    expect(toProductBenefit('promotion', 'percentage_discount', '20')).toEqual({
      action: 'percentage_discount', value: 20,
    });
    expect(toProductBenefit('promotion', 'waive', 5)).toEqual({ action: 'waive', value: null });
  });

  it('falls back to the neutral default rather than inventing a discount', () => {
    // A row written between migration 203's two statements, a value that went
    // missing, or an action a later ticket removed: none of them may price to
    // less than the normal price.
    expect(toProductBenefit('promotion', null, null)).toEqual(NO_PRODUCT_BENEFIT);
    expect(toProductBenefit('promotion', 'percentage_discount', null)).toEqual(NO_PRODUCT_BENEFIT);
    expect(toProductBenefit('promotion', 'fixed_price', 'abc')).toEqual(NO_PRODUCT_BENEFIT);
    expect(toProductBenefit('promotion', 'percentage_discount', -5)).toEqual(NO_PRODUCT_BENEFIT);
  });

  it('clamps rather than trusts, and respects the context', () => {
    expect(toProductBenefit('promotion', 'percentage_discount', 150)).toEqual({
      action: 'percentage_discount', value: 100,
    });
    // A `fixed_price` somehow stored on a Plan row reads as neutral, whatever
    // the column says — the context decides, not the data.
    expect(toProductBenefit('plan', 'fixed_price', 20)).toEqual(NO_PRODUCT_BENEFIT);
    // …but #997's retired value reads as itself: it is stored, it bills, and
    // normalizing it here would charge the full price for a discounted line.
    expect(toProductBenefit('plan', 'percentage_discount', '20.00')).toEqual({
      action: 'percentage_discount', value: 20,
    });
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
    // #997: the CHECK permits what may be **stored**, which is wider than what
    // may be configured — a Plan row that already carries `percentage_discount`
    // has to stay valid, so the migration's list is the stored set.
    expect(migration.PLAN_ACTIONS).toEqual([...STORED_PLAN_BENEFIT_ACTIONS]);
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
    // §12: the global Product is not one of them.
    for (const table of [...migration.PROMOTION_TABLES, ...migration.PLAN_TABLES]) {
      expect(table).not.toBe('products');
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

/* ── stage 2 ─────────────────────────────────────────────────────────────── */

describe('#896 stage 2 — reading one submitted line', () => {
  it('reports "not mentioned" rather than the default when no action is sent', () => {
    // The distinction is the whole point: the six `PUT`s are replace-all, and
    // a client that knows nothing about the pair must not silently rewrite it.
    expect(parseProductBenefitInput('promotion', { quantity: 3 } as any))
      .toEqual({ error: null, benefit: null });
    expect(parseProductBenefitInput('plan', {})).toEqual({ error: null, benefit: null });
    expect(parseProductBenefitInput('plan', { action: null, value: null }))
      .toEqual({ error: null, benefit: null });
  });

  it('refuses a value with no action', () => {
    // The one shape that reads as a configured discount the server would drop.
    const parsed = parseProductBenefitInput('promotion', { value: 20 });
    expect(parsed.error).toBe('value requires an action');
    expect(parsed.benefit).toBeNull();
  });

  it('accepts the five a Promotion may configure and normalizes the value', () => {
    expect(parseProductBenefitInput('promotion', { action: 'waive' }))
      .toEqual({ error: null, benefit: { action: 'waive', value: null } });
    // A string from a form body is a number by the time it is stored.
    expect(parseProductBenefitInput('promotion', { action: 'percentage_discount', value: '20' }))
      .toEqual({ error: null, benefit: { action: 'percentage_discount', value: 20 } });
    expect(parseProductBenefitInput('promotion', { action: 'fixed_price', value: 20 }))
      .toEqual({ error: null, benefit: { action: 'fixed_price', value: 20 } });
  });

  it('refuses the two a Membership Plan may not (§16)', () => {
    for (const action of ['fixed_discount', 'fixed_price']) {
      const parsed = parseProductBenefitInput('plan', { action, value: 10 });
      expect(parsed.error).toContain('action must be one of');
      expect(parsed.benefit).toBeNull();
    }
    // …while a Promotion takes both.
    expect(parseProductBenefitInput('promotion', { action: 'fixed_discount', value: 10 }).error)
      .toBeNull();
  });

  it('refuses a value the action does not take, and a missing one it does', () => {
    expect(parseProductBenefitInput('plan', { action: 'waive', value: 5 }).error)
      .toBe('waive takes no value');
    expect(parseProductBenefitInput('promotion', { action: 'percentage_discount' }).error)
      .toBe('percentage_discount requires a value');
    expect(parseProductBenefitInput('promotion', { action: 'percentage_discount', value: 120 }).error)
      .toBe('percentage_discount value must be between 0 and 100');
  });
});

describe('#896 stage 2 — reporting one stored row', () => {
  it('turns the DECIMAL string mysql2 hands back into a number', () => {
    expect(shapeProductBenefitRow('promotion', { product_id: 7, action: 'percentage_discount', value: '20.00' }))
      .toEqual({ product_id: 7, action: 'percentage_discount', value: 20 });
  });

  it('reports an action the context may not store as the neutral default', () => {
    // Nothing can put a `fixed_price` on a Plan row — the CHECK refuses it —
    // but a read must never hand the Plan editor an option it cannot offer.
    expect(shapeProductBenefitRow('plan', { action: 'fixed_price', value: '20.00' }))
      .toEqual({ action: 'no_benefit', value: null });
    // #997's retired value is a different case: the CHECK does permit it, so a
    // read reports it and the editor shows it as a disabled option.
    expect(shapeProductBenefitRow('plan', { action: 'percentage_discount', value: '20.00' }))
      .toEqual({ action: 'percentage_discount', value: 20 });
    expect(shapeProductBenefitRow('plan', { action: 'waive', value: null }))
      .toEqual({ action: 'waive', value: null });
  });
});

describe('#896 stage 2 — the mandatory rule carries the pair (#893)', () => {
  const item = {
    id: 9, name: 'Insurance Fee', type: 'other',
    billing_frequency: 'month', status: 'active', mandatory: 1,
  };

  it('shows a mandatory item a Plan has no row for at the neutral default', () => {
    // Mandatory says the item must be *there*, never what it costs.
    const merged = mergeMandatoryBenefits([], [item]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      product_id: 9, implicit: true, action: DEFAULT_BENEFIT_ACTION, value: null,
    });
  });

  it('re-adds a dropped mandatory item without naming a treatment', () => {
    // Naming none is what makes the route keep whatever the row was configured
    // with: preserving an item the client dropped must not reprice it.
    const written = withMandatoryBenefits([], [item]);
    expect(written).toEqual([{ product_id: 9, quantity: MANDATORY_BENEFIT_QUANTITY }]);
    expect(written[0].benefit).toBeUndefined();
  });

  it('passes a submitted mandatory item through with its own pair', () => {
    const submitted = [{ product_id: 9, quantity: 3, benefit: { action: 'waive' as const, value: null } }];
    expect(withMandatoryBenefits(submitted, [item])).toEqual(submitted);
  });
});

/* ── #997: `% Discount` retired from the Membership Plan surface ──────────── */

describe('#997 — the Plan set narrows to two, the stored set does not', () => {
  it('names exactly one retired action, and only on the Plan side', () => {
    expect(LEGACY_PLAN_BENEFIT_ACTIONS).toEqual(['percentage_discount']);
    expect(isRetiredBenefitAction('plan', 'percentage_discount')).toBe(true);
    // §8: a Promotion still configures all five, so nothing is retired there.
    expect(isRetiredBenefitAction('promotion', 'percentage_discount')).toBe(false);
    for (const action of PROMOTION_ITEM_ACTIONS) {
      expect(isRetiredBenefitAction('promotion', action)).toBe(false);
    }
  });

  it('keeps offered and stored as two different questions', () => {
    expect(STORED_PLAN_BENEFIT_ACTIONS).toEqual(['no_benefit', 'waive', 'percentage_discount']);
    expect(storedBenefitActionsFor('plan')).toBe(STORED_PLAN_BENEFIT_ACTIONS);
    // A Promotion's two sets are the same list, so nothing diverges there.
    expect(storedBenefitActionsFor('promotion')).toBe(PROMOTION_ITEM_ACTIONS);
    expect(isStoredBenefitAction('plan', 'percentage_discount')).toBe(true);
    expect(isBenefitActionAllowed('plan', 'percentage_discount')).toBe(false);
    // What neither set admits stays out of both.
    expect(isStoredBenefitAction('plan', 'fixed_price')).toBe(false);
    expect(isRetiredBenefitAction('plan', 'fixed_price')).toBe(false);
  });

  it('never leaves the set in a state where a Plan action is not a Promotion one', () => {
    for (const action of STORED_PLAN_BENEFIT_ACTIONS) {
      expect(PROMOTION_ITEM_ACTIONS).toContain(action);
    }
  });
});

describe('#997 — a retired treatment may be kept, never configured', () => {
  const stored = { action: 'percentage_discount' as const, value: 20 };

  it('accepts the stored pair carried back unchanged', () => {
    expect(keepsRetiredBenefit('plan', 'percentage_discount', 20, stored)).toBe(true);
    // mysql2 hands a DECIMAL back as a string on one side of this comparison.
    expect(keepsRetiredBenefit('plan', 'percentage_discount', '20', stored)).toBe(true);
    expect(benefitConfigError('plan', 'percentage_discount', 20, stored)).toBeNull();
    expect(parseProductBenefitInput('plan', { action: 'percentage_discount', value: 20 }, stored))
      .toEqual({ error: null, benefit: { action: 'percentage_discount', value: 20 } });
  });

  it('refuses a different percentage — keeping is not renegotiating', () => {
    expect(keepsRetiredBenefit('plan', 'percentage_discount', 50, stored)).toBe(false);
    expect(benefitConfigError('plan', 'percentage_discount', 50, stored))
      .toContain('no longer offered');
  });

  it('refuses it on a line that stores something else, or nothing at all', () => {
    expect(keepsRetiredBenefit('plan', 'percentage_discount', 20, null)).toBe(false);
    expect(keepsRetiredBenefit('plan', 'percentage_discount', 20, NO_PRODUCT_BENEFIT)).toBe(false);
    const err = benefitConfigError('plan', 'percentage_discount', 20);
    expect(err).toContain('no longer offered');
    expect(err).toContain('no_benefit, waive');
    expect(parseProductBenefitInput('plan', { action: 'percentage_discount', value: 20 }).error)
      .toBe(err);
  });

  it('is not a way around §16 — a Plan can never store the two monetary actions', () => {
    // `current` cannot launder an action the context does not even store: the
    // CHECK refuses it, so there is no row it could be "kept" from.
    expect(benefitConfigError('plan', 'fixed_price', 20,
      { action: 'fixed_price', value: 20 } as any)).toBe('action must be one of: no_benefit, waive');
  });

  it('ignores `current` for an action the context still offers', () => {
    // Nothing about the keep rule may loosen the ordinary validation.
    expect(benefitConfigError('plan', 'waive', 5, stored)).toBe('waive takes no value');
    expect(benefitConfigError('plan', 'no_benefit', null, stored)).toBeNull();
  });

  it('still prices a legacy line at its discount', () => {
    // §6: the row must not silently produce an incorrect price — in either
    // direction. Reading it as `no_benefit` would charge €100 for a line agreed
    // at €80; converting it to `waive` would charge nothing.
    const benefit = toProductBenefit('plan', 'percentage_discount', '20.00');
    expect(applyLineBenefit(50, 2, benefit)).toBe(80);
  });
});
