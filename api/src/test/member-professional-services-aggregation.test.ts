// Unit tests for aggregateProfessionalServiceGrants — pure function, no DB
// dependency (the SQL that feeds it lives in
// loadMemberProfessionalServiceGrants). #647 stage 1.

import { describe, expect, it } from 'vitest';
import {
  aggregateProfessionalServiceGrants,
  type ProfessionalServiceGrantRow,
} from '../domain/memberProfessionalServices';

function grant(overrides: Partial<ProfessionalServiceGrantRow> = {}): ProfessionalServiceGrantRow {
  return {
    professional_service_id: 1,
    professional_service_name: 'Personal Training Individual',
    kind: 'class_package',
    reference_id: 100,
    sellable_item_id: 900,
    sellable_item_name: 'Personal Training Class Package (10 Sessions)',
    sessions: 10,
    ...overrides,
  };
}

describe('aggregateProfessionalServiceGrants', () => {
  it('returns nothing for a member with no grants', () => {
    expect(aggregateProfessionalServiceGrants([])).toEqual([]);
  });

  it('sums sessions across sources for the same Professional Service', () => {
    // The worked example from the issue thread: a purchased 10-session
    // package plus 4 sessions granted by the assigned plan's promotion.
    const result = aggregateProfessionalServiceGrants([
      grant({ sessions: 10 }),
      grant({ kind: 'promotion_session', reference_id: 55, sellable_item_id: 901, sessions: 4 }),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ professional_service_id: 1, sessions: 14 });
    expect(result[0].sources.map((s) => s.kind)).toEqual(['class_package', 'promotion_session']);
  });

  it('keeps each Professional Service separate and sorts them by name', () => {
    const result = aggregateProfessionalServiceGrants([
      grant({ professional_service_id: 2, professional_service_name: 'Physiotherapy', sessions: 3 }),
      grant({ professional_service_id: 1, professional_service_name: 'Nutrition Coaching', sessions: 5 }),
    ]);

    expect(result.map((r) => r.name)).toEqual(['Nutrition Coaching', 'Physiotherapy']);
    expect(result.map((r) => r.sessions)).toEqual([5, 3]);
  });

  it('counts one session package once per Professional Service it is linked to', () => {
    // A bundle delivered by two services: the same credits back both, so each
    // service reports the full balance rather than a split of it.
    const result = aggregateProfessionalServiceGrants([
      grant({ professional_service_id: 1, professional_service_name: 'Personal Training Individual' }),
      grant({ professional_service_id: 2, professional_service_name: 'Physiotherapy' }),
    ]);

    expect(result.map((r) => r.sessions)).toEqual([10, 10]);
  });

  it('de-duplicates a grant repeated by JOIN fan-out', () => {
    const result = aggregateProfessionalServiceGrants([grant(), grant(), grant()]);

    expect(result[0].sessions).toBe(10);
    expect(result[0].sources).toHaveLength(1);
  });

  it('treats two applications of the same benefit as separate grants', () => {
    // reference_id is the application row, so the same Promotion applied to
    // two active assignments grants its sessions twice.
    const result = aggregateProfessionalServiceGrants([
      grant({ kind: 'promotion_session', reference_id: 1, sessions: 4 }),
      grant({ kind: 'promotion_session', reference_id: 2, sessions: 4 }),
    ]);

    expect(result[0].sessions).toBe(8);
    expect(result[0].sources).toHaveLength(2);
  });

  it('drops grants with no sessions left', () => {
    expect(aggregateProfessionalServiceGrants([grant({ sessions: 0 })])).toEqual([]);
    expect(aggregateProfessionalServiceGrants([grant({ sessions: -1 })])).toEqual([]);
  });

  it('accepts the string counts mysql2 returns for computed columns', () => {
    const result = aggregateProfessionalServiceGrants([
      grant({ sessions: '10' }),
      grant({ kind: 'membership_service', reference_id: 7, sellable_item_id: 902, sessions: '20' }),
    ]);

    expect(result[0].sessions).toBe(30);
  });

  it('records where each grant came from', () => {
    const result = aggregateProfessionalServiceGrants([
      grant({ kind: 'membership_service', reference_id: 42, sellable_item_id: 903, sessions: 20, sellable_item_name: 'PT Pack' }),
    ]);

    expect(result[0].sources[0]).toEqual({
      kind: 'membership_service',
      reference_id: 42,
      sellable_item_id: 903,
      sellable_item_name: 'PT Pack',
      sessions: 20,
    });
  });
});
