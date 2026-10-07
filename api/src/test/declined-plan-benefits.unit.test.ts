import { describe, it, expect } from 'vitest';
import { parseDeclinedBenefits, declinedBenefitsError, type PlanBenefitLine } from '../domain/declinedPlanBenefits';

const lines: PlanBenefitLine[] = [
  { section: 'oneoff', product_id: 1, mandatory: true },
  { section: 'periodical', product_id: 2, mandatory: false },
  { section: 'session', product_id: 3, mandatory: false },
];

describe('parseDeclinedBenefits', () => {
  it('treats absent/null as nothing declined', () => {
    expect(parseDeclinedBenefits(undefined)).toEqual({ ok: true, declined: [] });
    expect(parseDeclinedBenefits(null)).toEqual({ ok: true, declined: [] });
  });
  it('dedupes and normalises entries', () => {
    expect(parseDeclinedBenefits([
      { section: 'session', product_id: '3' }, { section: 'session', product_id: 3 },
    ])).toEqual({ ok: true, declined: [{ section: 'session', product_id: 3 }] });
  });
  it('rejects malformed input', () => {
    expect(parseDeclinedBenefits('x').ok).toBe(false);
    expect(parseDeclinedBenefits([{ section: 'bogus', product_id: 1 }]).ok).toBe(false);
    expect(parseDeclinedBenefits([{ section: 'session', product_id: 0 }]).ok).toBe(false);
  });
});

describe('declinedBenefitsError', () => {
  it('allows declining optional benefits', () => {
    expect(declinedBenefitsError(lines, [{ section: 'periodical', product_id: 2 }])).toBeNull();
  });
  it('refuses a mandatory benefit', () => {
    expect(declinedBenefitsError(lines, [{ section: 'oneoff', product_id: 1 }])).toMatch(/mandatory/);
  });
  it('refuses an injected or wrong-section product', () => {
    expect(declinedBenefitsError(lines, [{ section: 'session', product_id: 99 }])).toMatch(/not a session benefit/);
    expect(declinedBenefitsError(lines, [{ section: 'oneoff', product_id: 2 }])).toMatch(/not a oneoff benefit/);
  });
});
