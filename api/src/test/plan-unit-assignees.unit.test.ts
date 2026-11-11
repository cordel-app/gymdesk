// #2609 stage 3 — the per-unit distribution rule of a plan's Individual Products.

import { describe, expect, it } from 'vitest';
import { defaultUnitAssignees, effectiveUnitAssignees, parseUnitAssigneesInput } from '../domain/planUnitAssignees';

describe('defaultUnitAssignees', () => {
  it('gives one unit per beneficiary, wraps when there are more units, falls back to the owner', () => {
    expect(defaultUnitAssignees(3, [1, 2, 3], 1)).toEqual([1, 2, 3]);
    expect(defaultUnitAssignees(2, [1, 2, 3], 1)).toEqual([1, 2]);
    expect(defaultUnitAssignees(5, [1, 2], 1)).toEqual([1, 2, 1, 2, 1]);
    expect(defaultUnitAssignees(2, [], 9)).toEqual([9, 9]);
  });
});

describe('effectiveUnitAssignees', () => {
  const base = { ownerId: 1, beneficiaryIds: [1, 2, 3], eligibleIds: [1, 2, 3, 4], sharingType: 'individual' };
  it('reads a shared Product as having no per-unit assignee', () => {
    expect(effectiveUnitAssignees({ ...base, stored: [2], quantity: 1, sharingType: 'shared' })).toBeNull();
  });
  it('keeps eligible stored choices and fills the rest with the default for that position', () => {
    expect(effectiveUnitAssignees({ ...base, stored: '[4, 4]', quantity: 3 })).toEqual([4, 4, 3]);
    expect(effectiveUnitAssignees({ ...base, stored: [99, 2, 2], quantity: 3 })).toEqual([1, 2, 2]);
    expect(effectiveUnitAssignees({ ...base, stored: [2, 2, 2, 2], quantity: 2 })).toEqual([2, 2]);
    expect(effectiveUnitAssignees({ ...base, stored: null, quantity: 3 })).toEqual([1, 2, 3]);
  });
});

describe('parseUnitAssigneesInput', () => {
  const base = { quantity: 2, sharingType: 'individual', eligibleIds: [1, 2] };
  it('accepts one eligible member per unit', () => {
    expect(parseUnitAssigneesInput({ ...base, raw: [2, '2'] })).toEqual({ ok: true, assignees: [2, 2] });
  });
  it('refuses rather than coerces', () => {
    expect(parseUnitAssigneesInput({ ...base, raw: 'x' })).toEqual({ ok: false, error: 'assignees_invalid' });
    expect(parseUnitAssigneesInput({ ...base, raw: [1, null] })).toEqual({ ok: false, error: 'assignees_invalid' });
    expect(parseUnitAssigneesInput({ ...base, raw: [1] })).toEqual({ ok: false, error: 'assignees_wrong_length' });
    expect(parseUnitAssigneesInput({ ...base, raw: [1, 7] })).toEqual({ ok: false, error: 'assignee_not_in_family' });
    expect(parseUnitAssigneesInput({ ...base, raw: [1, 2], sharingType: 'shared' })).toEqual({ ok: false, error: 'assignee_not_allowed' });
  });
});
