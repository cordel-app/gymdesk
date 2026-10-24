import { describe, it, expect } from 'vitest';
import { selectableServices, requiredServiceNames } from '../../../apps/member/src/lib/serviceRequired';

const body = { professional_services: [{ id: 3, name: 'PT Duo' }, { id: 4, name: 'PT Individual' }] };

describe('#1985 service selection helpers', () => {
  it('lists the services to choose between for a selection request', () => {
    expect(selectableServices({ code: 'professional_service_selection_required', body })).toEqual([
      { id: 3, name: 'PT Duo' }, { id: 4, name: 'PT Individual' },
    ]);
  });
  it('is empty for any other error', () => {
    expect(selectableServices({ code: 'professional_service_required', body })).toEqual([]);
  });
  it('names the services a refused booking would be unlocked by', () => {
    expect(requiredServiceNames({ code: 'professional_service_required', body })).toEqual(['PT Duo', 'PT Individual']);
    expect(requiredServiceNames({ code: 'other', body })).toEqual([]);
  });
});
