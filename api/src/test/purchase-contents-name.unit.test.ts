// #3553 — the name an Admin Save & Pay purchase takes from what it pays for.
import { describe, expect, it } from 'vitest';
import { contentsPurchaseName, type PurchaseContents } from '../domain/purchaseName';

const none: PurchaseContents = { plans: [], products: [], cancelledPlans: [], cancelledProducts: [] };
const name = (c: Partial<PurchaseContents>, locale = 'en') =>
  contentsPurchaseName({ gymName: 'Gym', locale, contents: { ...none, ...c } });

describe('contentsPurchaseName (#3553)', () => {
  it('one Product alone, or one Plan alone, by name', () => {
    expect(name({ products: ['Locker'] })).toBe('Gym - Locker');
    expect(name({ plans: ['Gold'] })).toBe('Gym - Gold');
  });

  it('anything else counts both categories, zero included', () => {
    expect(name({ products: ['A', 'B'] })).toBe('Gym - 2 products · 0 plans');
    expect(name({ plans: ['Gold'], products: ['Locker'] })).toBe('Gym - 1 product · 1 plan');
    expect(name({ plans: ['Gold', 'Duo'], products: ['A', 'B', 'C'] })).toBe('Gym - 3 products · 2 plans');
    expect(name({ plans: ['Gold', 'Duo'] }, 'es')).toBe('Gym - 0 productos · 2 planes');
  });

  it('a cart that only cancels is named after what it cancels, with the suffix', () => {
    expect(name({ cancelledPlans: ['Gold'] })).toBe('Gym - Gold (Cancellation)');
    expect(name({ cancelledProducts: ['Locker'] }, 'es')).toBe('Gym - Locker (Cancelación)');
    expect(name({ cancelledProducts: ['Locker'] }, 'ca')).toBe('Gym - Locker (Cancel·lació)');
    expect(name({ cancelledPlans: ['Gold'], cancelledProducts: ['Locker'] })).toBe('Gym - 1 product · 1 plan (Cancellation)');
  });

  it('what a cart adds names it even when it also cancels', () => {
    expect(name({ plans: ['Duo'], cancelledPlans: ['Gold'] })).toBe('Gym - Duo');
  });

  it('a cart that names nothing keeps its canonical name (null)', () => {
    expect(name({})).toBeNull();
  });

  it('never exceeds the column', () => {
    const long = contentsPurchaseName({ gymName: 'G'.repeat(255), locale: 'en', contents: { ...none, products: ['P'.repeat(255)] } })!;
    expect(long.length).toBe(320);
  });
});
