// Unit tests for validatePromotionStacking — pure function, no DB dependency. #628.

import { describe, expect, it } from 'vitest';
import { validatePromotionStacking } from '../domain/promotionStacking';

const stackable = (id: number) => ({ id, stackable: true });
const exclusive = (id: number) => ({ id, stackable: false });

describe('validatePromotionStacking', () => {
  it('accepts an empty selection', () => {
    expect(validatePromotionStacking([])).toEqual({ ok: true });
  });

  it('accepts a single stackable promotion', () => {
    expect(validatePromotionStacking([stackable(1)])).toEqual({ ok: true });
  });

  it('accepts a single non-stackable promotion', () => {
    expect(validatePromotionStacking([exclusive(1)])).toEqual({ ok: true });
  });

  it('accepts several stackable promotions together', () => {
    expect(validatePromotionStacking([stackable(1), stackable(2), stackable(3)])).toEqual({ ok: true });
  });

  it('rejects a non-stackable promotion combined with a stackable one', () => {
    const result = validatePromotionStacking([exclusive(1), stackable(2)]);
    expect(result.ok).toBe(false);
  });

  it('rejects the same combination regardless of selection order', () => {
    expect(validatePromotionStacking([stackable(2), exclusive(1)]).ok).toBe(false);
  });

  it('rejects two non-stackable promotions', () => {
    expect(validatePromotionStacking([exclusive(1), exclusive(2)]).ok).toBe(false);
  });

  it('rejects the same promotion selected twice', () => {
    const result = validatePromotionStacking([stackable(1), stackable(1)]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('more than once');
  });
});
