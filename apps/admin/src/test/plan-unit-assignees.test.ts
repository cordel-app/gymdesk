// #2609 stage 3 — the Assigned Plan card's view of a plan's per-unit family members.
import { describe, expect, it } from 'vitest';
import { changedUnitLines, showsUnitAssignees, unitAssigneeLines, unitLineKey } from '@/lib/planUnitAssignees';

const m = (member_id: number, name: string) => ({ member_id, name });
const snapshot = {
  oneoff_benefits: [
    { product_id: 1, item_name: 'Insurance', unit_assignees: [m(10, 'Ana'), m(11, 'Bea')] },
    { product_id: 2, item_name: 'Family box', unit_assignees: null },
  ],
  session_benefits: [],
  periodical_benefits: [{ product_id: 3, item_name: 'Locker', unit_assignees: [m(10, 'Ana')] }],
};

describe('plan unit assignees', () => {
  it('lists only the lines with a per-unit assignee, in section order', () => {
    const lines = unitAssigneeLines(snapshot);
    expect(lines.map((l) => [l.section, l.product_id, l.assignees])).toEqual([['oneoff', 1, [10, 11]], ['periodical', 3, [10]]]);
    expect(lines[0].names).toEqual(['Ana', 'Bea']);
  });
  it('is shown only with a line and more than one possible recipient', () => {
    const lines = unitAssigneeLines(snapshot);
    expect(showsUnitAssignees(lines, 2)).toBe(true);
    expect(showsUnitAssignees(lines, 1)).toBe(false);
    expect(showsUnitAssignees([], 3)).toBe(false);
  });
  it('sends only the lines whose draft changed', () => {
    const lines = unitAssigneeLines(snapshot);
    const draft = { [unitLineKey(lines[0])]: [11, 11], [unitLineKey(lines[1])]: [10] };
    expect(changedUnitLines(lines, draft).map((l) => [l.product_id, l.assignees])).toEqual([[1, [11, 11]]]);
  });
});
