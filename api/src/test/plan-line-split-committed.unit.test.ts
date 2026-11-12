// #2657 stage 4 — when a Session line committed before stage 3 is split per member, its
// renewals are shared out over the member lines and each holder's spends follow, both
// without changing the total. The flow against MySQL is `plan-line-split-committed.test.ts`.

import { describe, expect, it } from 'vitest';
import { distributeSpends, shareUnits } from '../domain/planLineAllocation';

describe('shareUnits()', () => {
  it('gives each member their own quantity when the renewal equals the line', () => {
    expect(shareUnits(4, [2, 2])).toEqual([2, 2]);
    expect(shareUnits(3, [2, 1])).toEqual([2, 1]);
  });

  it('shares an older, different renewal in proportion, the remainder to the earlier line', () => {
    expect(shareUnits(3, [1, 1])).toEqual([2, 1]);
    expect(shareUnits(1, [1, 1, 1])).toEqual([1, 0, 0]);
    expect(shareUnits(5, [2, 1])).toEqual([3, 2]);
  });

  it('always sums to the total', () => {
    for (const total of [0, 1, 2, 7, 13]) {
      for (const w of [[1], [1, 1], [3, 1, 2], [5, 5, 5, 5]]) {
        expect(shareUnits(total, w).reduce((a, b) => a + b, 0)).toBe(total);
      }
    }
  });
});

describe('distributeSpends()', () => {
  it('fills the original line first, then the next', () => {
    expect(distributeSpends(3, [2, 2])).toEqual([2, 1]);
    expect(distributeSpends(1, [2, 2])).toEqual([1, 0]);
  });

  it('keeps a spend beyond every line on the original one (a debt stays a debt)', () => {
    expect(distributeSpends(5, [2, 2])).toEqual([3, 2]);
  });

  it('moves nothing with no spends', () => {
    expect(distributeSpends(0, [1, 1])).toEqual([0, 0]);
  });
});
