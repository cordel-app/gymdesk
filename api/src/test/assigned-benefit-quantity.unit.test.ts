// #1187 — the quantity an Assigned Plan benefit line carries. Pure rule, no DB.
import { describe, expect, it } from 'vitest';
import {
  coveredMemberCount,
  resolveAssignedPlanBenefitQuantity,
} from '../domain/assignedBenefitQuantity';

describe('resolveAssignedPlanBenefitQuantity', () => {
  it('a catalogue-mandatory Product takes the covered-Member count', () => {
    for (const n of [1, 2, 4]) {
      expect(resolveAssignedPlanBenefitQuantity({
        productMandatory: true, configuredQuantity: 1, memberCount: n,
      })).toBe(n);
    }
  });

  it('replaces the configured quantity rather than multiplying it', () => {
    expect(resolveAssignedPlanBenefitQuantity({
      productMandatory: true, configuredQuantity: 2, memberCount: 3,
    })).toBe(3);
  });

  it('any other Product keeps its configured quantity', () => {
    expect(resolveAssignedPlanBenefitQuantity({
      productMandatory: false, configuredQuantity: 2, memberCount: 4,
    })).toBe(2);
  });
});

describe('coveredMemberCount', () => {
  it('never answers below 1 — the owner is always covered', () => {
    expect(coveredMemberCount(0)).toBe(1);
    expect(coveredMemberCount(null)).toBe(1);
    expect(coveredMemberCount('3')).toBe(3);
  });
});
