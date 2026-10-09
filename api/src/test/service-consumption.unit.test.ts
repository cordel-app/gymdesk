import { describe, expect, it } from 'vitest';
import {
  applyConsumption,
  chooseSpendGrant,
  isLateCancellation,
  reasonForAttendance,
} from '../domain/serviceConsumption';
import type { ProfessionalServiceGrantRow } from '../domain/memberProfessionalServices';

const row = (
  kind: ProfessionalServiceGrantRow['kind'],
  reference_id: number,
  sessions: number,
  professional_service_id = 1,
): ProfessionalServiceGrantRow => ({
  professional_service_id, professional_service_name: 'PT', kind, reference_id,
  product_id: 10, product_name: 'P', sessions,
});

describe('serviceConsumption', () => {
  it('a cancellation is late inside the notice window and only there', () => {
    expect(isLateCancellation(23 * 3600)).toBe(true);
    expect(isLateCancellation(24 * 3600)).toBe(false);
    expect(isLateCancellation(48 * 3600)).toBe(false);
  });

  it('attendance spends under attendance, absence under no_show', () => {
    expect(reasonForAttendance('present')).toBe('attendance');
    expect(reasonForAttendance('absent')).toBe('no_show');
  });

  it('subtracts ledger rows from counter-less grants but not from packages', () => {
    const out = applyConsumption(
      [row('plan_session', 5, 4), row('class_package', 7, 3)],
      [{ source_kind: 'plan_session', source_reference_id: 5, consumed: 1 },
       { source_kind: 'class_package', source_reference_id: 7, consumed: 2 }],
    );
    expect(out.map((r) => r.sessions)).toEqual([3, 3]);
  });

  it('spends plan-included sessions before purchased ones', () => {
    const grant = chooseSpendGrant(
      [row('class_package', 1, 5), row('plan_session', 9, 2), row('promotion_session', 3, 1)],
      [1],
    );
    expect(grant?.kind).toBe('plan_session');
  });

  it('falls through to the package once the plan is spent', () => {
    const rows = applyConsumption(
      [row('plan_session', 9, 1), row('class_package', 1, 5)],
      [{ source_kind: 'plan_session', source_reference_id: 9, consumed: 1 }],
    );
    expect(chooseSpendGrant(rows, [1])?.kind).toBe('class_package');
  });

  it('ignores services the occurrence does not require, and answers null with no balance', () => {
    expect(chooseSpendGrant([row('plan_session', 1, 3, 2)], [1])).toBeNull();
    expect(chooseSpendGrant([row('plan_session', 1, 0)], [1])).toBeNull();
  });
});
