import { describe, expect, it } from 'vitest';
import { toMinorUnits } from '../payments/money';

// Pure helper — no DB, no HTTP. The four provider callers (customer checkout,
// staff checkout link, nightly run, staff Retry) all convert through it, so a
// regression here would move real money in the wrong unit.
describe('toMinorUnits()', () => {
  it('converts a euro amount to whole cents', () => {
    expect(toMinorUnits(45.99)).toBe(4599);
    expect(toMinorUnits(29.99)).toBe(2999);
    expect(toMinorUnits(40)).toBe(4000);
    expect(toMinorUnits(0)).toBe(0);
  });

  it('accepts the DECIMAL string form the mysql driver returns', () => {
    expect(toMinorUnits('45.99')).toBe(4599);
    expect(toMinorUnits('40.00')).toBe(4000);
  });

  it('rounds binary-float residue to the nearest cent', () => {
    expect(toMinorUnits(0.1 + 0.2)).toBe(30);
    expect(toMinorUnits(1.005)).toBe(101);
    expect(toMinorUnits(19.999)).toBe(2000);
  });

  it('refuses a non-numeric amount instead of charging NaN', () => {
    expect(() => toMinorUnits('abc')).toThrow(/finite/);
    expect(() => toMinorUnits(Number.NaN)).toThrow(/finite/);
    expect(() => toMinorUnits(Number.POSITIVE_INFINITY)).toThrow(/finite/);
  });
});
