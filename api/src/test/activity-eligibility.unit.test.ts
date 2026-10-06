import { describe, expect, it } from 'vitest';
import { decideServiceEligibility } from '../domain/activityEligibility';
import type { MemberProfessionalService } from '../domain/memberProfessionalServices';

// #973 stage 1 — the one rule both the booking gate and the PT-slot
// projection ask.

function service(
  id: number,
  sessions: number,
  kinds: Array<'class_package' | 'promotion_session' | 'membership_service'> = ['class_package'],
): MemberProfessionalService {
  return {
    professional_service_id: id,
    name: `Service ${id}`,
    sessions,
    sources: kinds.map((kind, i) => ({ kind, reference_id: i + 1, product_id: 10 + i, product_name: 'P', sessions })),
  };
}

describe('decideServiceEligibility', () => {
  it('an activity naming no service is open to every member (Q3 open)', () => {
    const d = decideServiceEligibility([], []);
    expect(d.eligible).toBe(true);
    expect(d.packageBacked).toBe(false);
  });

  it('a member with no sessions on any required service is not eligible, and the refusal names the services', () => {
    const required = [{ id: 1, name: 'PT' }, { id: 2, name: 'Physio' }];
    const d = decideServiceEligibility(required, [service(3, 5)]);
    expect(d.eligible).toBe(false);
    expect(d.required).toEqual(required);
    expect(d.matched).toEqual([]);
  });

  it('a balance on one required service is enough', () => {
    const d = decideServiceEligibility([{ id: 1, name: 'PT' }, { id: 2, name: 'Physio' }], [service(2, 1)]);
    expect(d.eligible).toBe(true);
    expect(d.matched.map((m) => m.professional_service_id)).toEqual([2]);
  });

  it('a zero balance is not a balance', () => {
    expect(decideServiceEligibility([{ id: 1, name: 'PT' }], [service(1, 0)]).eligible).toBe(false);
  });

  it('is package-backed only when every matching source is a purchased package', () => {
    const required = [{ id: 1, name: 'PT' }];
    expect(decideServiceEligibility(required, [service(1, 5, ['class_package'])]).packageBacked).toBe(true);
    expect(decideServiceEligibility(required, [service(1, 5, ['promotion_session'])]).packageBacked).toBe(false);
    expect(decideServiceEligibility(required, [service(1, 5, ['class_package', 'membership_service'])]).packageBacked).toBe(false);
    // A package on an *unrequired* service does not make the decision package-backed.
    expect(decideServiceEligibility(required, [service(1, 5, ['membership_service']), service(9, 5)]).packageBacked).toBe(false);
  });
});
