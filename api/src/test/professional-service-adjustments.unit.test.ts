import { describe, expect, it } from 'vitest';
import {
  applyAdjustmentsToGrants,
  netAdjustments,
  parseAdjustmentInput,
  sortHistory,
} from '../domain/professionalServiceAdjustments';
import { SPEND_ORDER, chooseSpendGrant } from '../domain/serviceConsumption';
import type { ProfessionalServiceGrantRow } from '../domain/memberProfessionalServices';

const grant = (kind: ProfessionalServiceGrantRow['kind'], id: number, sessions: number): ProfessionalServiceGrantRow => ({
  professional_service_id: 1, professional_service_name: 'PT', kind, reference_id: id, product_id: 9, product_name: 'P', sessions,
});

describe('parseAdjustmentInput', () => {
  it('accepts a non-negative integer and an optional reason', () => {
    expect(parseAdjustmentInput({ new_balance: 3, reason: ' gift ' })).toEqual({ new_balance: 3, reason: 'gift' });
    expect(parseAdjustmentInput({ new_balance: 0 })).toEqual({ new_balance: 0, reason: null });
  });
  it('rejects anything else rather than coercing it', () => {
    for (const bad of [{ new_balance: -1 }, { new_balance: 1.5 }, { new_balance: '3' }, {}, null]) {
      expect(parseAdjustmentInput(bad)).toHaveProperty('error');
    }
    expect(parseAdjustmentInput({ new_balance: 1, reason: 5 })).toHaveProperty('error');
    expect(parseAdjustmentInput({ new_balance: 1, reason: 'x'.repeat(256) })).toHaveProperty('error');
  });
});

describe('applyAdjustmentsToGrants', () => {
  const names = new Map([[1, 'PT']]);
  it('turns a positive net into a manual_adjustment grant that is spendable', () => {
    const out = applyAdjustmentsToGrants([grant('class_package', 1, 2)], netAdjustments([
      { professional_service_id: 1, delta: 2 }, { professional_service_id: 1, delta: 1 },
    ]), names, SPEND_ORDER);
    const manual = out.find((r) => r.kind === 'manual_adjustment');
    expect(manual?.sessions).toBe(3);
    expect(chooseSpendGrant([manual!], [1])?.kind).toBe('manual_adjustment');
  });
  it('takes a negative net off the grants that would be spent last', () => {
    const out = applyAdjustmentsToGrants(
      [grant('plan_session', 1, 4), grant('class_package', 2, 2)],
      netAdjustments([{ professional_service_id: 1, delta: -3 }]), names, SPEND_ORDER,
    );
    expect(out.find((r) => r.kind === 'class_package')?.sessions).toBe(0);
    expect(out.find((r) => r.kind === 'plan_session')?.sessions).toBe(3);
  });
  it('does not mutate its input', () => {
    const g = [grant('plan_session', 1, 4)];
    applyAdjustmentsToGrants(g, new Map([[1, -2]]), names, SPEND_ORDER);
    expect(g[0].sessions).toBe(4);
  });
});

describe('sortHistory', () => {
  it('orders newest first', () => {
    const e = (at: string) => ({ kind: 'adjustment' as const, at, quantity: 1, reason: null, balance_before: 0, balance_after: 1, actor: null });
    expect(sortHistory([e('2026-01-01T00:00:00.000Z'), e('2026-02-01T00:00:00.000Z')]).map((x) => x.at[6])).toEqual(['2', '1']);
  });
});
