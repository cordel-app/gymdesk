import { describe, it, expect } from 'vitest';
import { declinedPayload, isBenefitMandatory, toAssignableBenefits, benefitKey } from '@/lib/declinedBenefits';

describe('declinedBenefits (#1184 stage 3)', () => {
  const benefits = [
    ...toAssignableBenefits('oneoff', [{ product_id: 1, product_name: 'Insurance', mandatory: 1 }]),
    ...toAssignableBenefits('periodical', [{ product_id: 2, product_name: 'Locker', mandatory: 0 }]),
  ];
  it('reads the stored flag, defaulting to Yes', () => {
    expect(isBenefitMandatory(undefined)).toBe(true);
    expect(isBenefitMandatory(0)).toBe(false);
    expect(isBenefitMandatory(true)).toBe(true);
  });
  it('sends only unticked optional lines', () => {
    expect(declinedPayload(benefits, new Set([benefitKey(benefits[1])])))
      .toEqual([{ section: 'periodical', product_id: 2 }]);
  });
  it('never sends a mandatory line even if it is in the declined set', () => {
    expect(declinedPayload(benefits, new Set([benefitKey(benefits[0])]))).toEqual([]);
  });
});
