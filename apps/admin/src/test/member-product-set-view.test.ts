import { describe, expect, it } from 'vitest';
import {
  productSetName,
  productSetStatusKey,
  splitProductSetProducts,
} from '@/app/[locale]/members/productSetView';

// #1463 — the Products tab's pure ProductSet presentation.
describe('productSetView (#1463)', () => {
  it('derives the name from the plan and version, never a stored name', () => {
    expect(productSetName({ plan_name: 'Gold', version: 3 }, 'Products only')).toBe('Gold — v3');
    expect(productSetName({ plan_name: null, version: 1 }, 'Products only')).toBe('Products only — v1');
  });

  it('maps statuses to keys, an expired draft included', () => {
    expect(productSetStatusKey('draft', false)).toBe('product_set_status_draft');
    expect(productSetStatusKey('draft', true)).toBe('product_set_status_expired');
    expect(productSetStatusKey('active', false)).toBe('product_set_status_active');
    expect(productSetStatusKey('superseded', false)).toBe('product_set_status_superseded');
    expect(productSetStatusKey('weird', false)).toBeNull();
  });

  it('splits one-off/session lines from periodical lines and recurring services', () => {
    const out = splitProductSetProducts({
      planBenefits: [
        { productId: 1, name: 'Locker', category: 'oneoff', quantity: 1, unitPrice: 10, billingFrequency: 'once' },
        { productId: 2, name: 'PT x5', category: 'session', quantity: 1, unitPrice: 50, billingFrequency: 'once' },
        { productId: 3, name: 'Towel', category: 'periodical', quantity: 1, unitPrice: 5, billingFrequency: 'month' },
      ],
      services: [
        { id: 9, productId: 4, name: 'Parking', quantity: 1, unitPrice: 20, billingFrequency: 'month', startsOn: '2026-01-01', endsOn: null },
      ],
    });
    expect(out.oneOff.map((l) => l.name)).toEqual(['Locker', 'PT x5']);
    expect(out.recurring.map((l) => l.name)).toEqual(['Towel', 'Parking']);
    expect(splitProductSetProducts(null)).toEqual({ oneOff: [], recurring: [] });
  });
});
