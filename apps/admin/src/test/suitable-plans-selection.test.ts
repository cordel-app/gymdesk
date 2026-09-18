import { describe, expect, it } from 'vitest';
import { isAllSelected, isIndeterminate, toggleSelectAll } from '../lib/suitablePlansSelection';

// #554 — Select All checkbox for the Suitable Membership Plans section:
// selects/deselects every *displayed* (active) plan and reflects an
// indeterminate state when only some are selected, without ever touching a
// pre-existing association with a plan that isn't currently displayed
// (e.g. one that has since gone inactive).

describe('isAllSelected', () => {
  it('is false when there are no active plans to select', () => {
    expect(isAllSelected([], [])).toBe(false);
  });

  it('is false when only some active plans are selected', () => {
    expect(isAllSelected([1, 2, 3], [1, 2])).toBe(false);
  });

  it('is true when every active plan is selected', () => {
    expect(isAllSelected([1, 2, 3], [1, 2, 3])).toBe(true);
  });

  it('is true even if extra (non-active) ids are also selected', () => {
    // e.g. a legacy association with a now-inactive plan, id 99
    expect(isAllSelected([1, 2, 3], [1, 2, 3, 99])).toBe(true);
  });
});

describe('isIndeterminate', () => {
  it('is false when nothing is selected', () => {
    expect(isIndeterminate([1, 2, 3], [])).toBe(false);
  });

  it('is false when everything is selected', () => {
    expect(isIndeterminate([1, 2, 3], [1, 2, 3])).toBe(false);
  });

  it('is true when some but not all active plans are selected', () => {
    expect(isIndeterminate([1, 2, 3], [1])).toBe(true);
  });

  it('ignores selected ids that are not in the active set', () => {
    // Only a legacy/inactive association (id 99) is selected — no active
    // plan is checked, so this isn't a partial selection of what's shown.
    expect(isIndeterminate([1, 2, 3], [99])).toBe(false);
  });
});

describe('toggleSelectAll', () => {
  it('checked=true adds every active id to the selection', () => {
    expect(toggleSelectAll([], [1, 2, 3], true).sort()).toEqual([1, 2, 3]);
  });

  it('checked=true preserves a pre-existing non-active selection (legacy/inactive plan)', () => {
    expect(toggleSelectAll([99], [1, 2, 3], true).sort()).toEqual([1, 2, 3, 99]);
  });

  it('checked=true does not duplicate an id already selected', () => {
    expect(toggleSelectAll([1], [1, 2, 3], true).sort()).toEqual([1, 2, 3]);
  });

  it('checked=false removes every active id from the selection', () => {
    expect(toggleSelectAll([1, 2, 3], [1, 2, 3], false)).toEqual([]);
  });

  it('checked=false keeps a pre-existing non-active selection untouched', () => {
    // Deselect-all must never silently drop an association with a plan
    // that isn't currently displayed (Historical Integrity, #554).
    expect(toggleSelectAll([1, 2, 99], [1, 2, 3], false)).toEqual([99]);
  });
});
