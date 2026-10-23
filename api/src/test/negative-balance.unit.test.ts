import { describe, it, expect } from 'vitest';
import { applyConsumption } from '../domain/serviceConsumption';
import { aggregateProfessionalServiceGrants, ProfessionalServiceGrantRow } from '../domain/memberProfessionalServices';

const debtRow = (serviceId: number, sessions: number): ProfessionalServiceGrantRow => ({
  professional_service_id: serviceId, professional_service_name: `S${serviceId}`, kind: 'manual_adjustment',
  reference_id: 0, product_id: 0, product_name: '', sessions,
});

describe('#1986 negative Professional Service balance', () => {
  it('matches a manual-adjustment spend to its own service only', () => {
    const rows = applyConsumption(
      [debtRow(1, 0), debtRow(2, 3)],
      [{ source_kind: 'manual_adjustment', source_reference_id: 0, consumed: 1, professional_service_id: 1 }],
    );
    expect(rows.map((r) => Number(r.sessions))).toEqual([-1, 3]);
  });

  it('still reduces a shared grant by the total spent across services', () => {
    const shared: ProfessionalServiceGrantRow = { ...debtRow(1, 5), kind: 'plan_session', reference_id: 9 };
    const rows = applyConsumption([shared], [
      { source_kind: 'plan_session', source_reference_id: 9, consumed: 1, professional_service_id: 1 },
      { source_kind: 'plan_session', source_reference_id: 9, consumed: 2, professional_service_id: 2 },
    ]);
    expect(Number(rows[0].sessions)).toBe(2);
  });

  it('reports a debt as a negative balance and drops other non-positive rows', () => {
    const out = aggregateProfessionalServiceGrants([debtRow(1, -2), { ...debtRow(2, 0), kind: 'plan_session', reference_id: 4 }]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ professional_service_id: 1, sessions: -2 });
  });

  it('nets a debt against a later positive grant', () => {
    const out = aggregateProfessionalServiceGrants([debtRow(1, -1), { ...debtRow(1, 4), kind: 'plan_session', reference_id: 4 }]);
    expect(out[0].sessions).toBe(3);
  });
});
