import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// #1692 — a successful assignment opens, scrolls to and focuses the new card.
// Source scan, like assign-plan-inline-no-benefits.test.ts (no component infra).
const SRC = join(__dirname, '..');
const read = (...p: string[]) => readFileSync(join(SRC, ...p), 'utf-8');

describe('Assign plan opens the new card (#1692)', () => {
  it('reports the created assignment id only after a successful POST', () => {
    const s = read('app', '[locale]', 'plans', 'AssignPlanToMembersEditor.tsx');
    expect(s).toMatch(/const created = await apiFetch/);
    expect(s).toMatch(/onAssigned\(typeof created\?\.id === 'number'/);
  });
  it('the Member card opens that id through the table\'s existing openInEditId', () => {
    const s = read('app', '[locale]', 'members', 'MemberMembershipPlans.tsx');
    expect(s).toMatch(/if \(created\) setNewDraftId\(created\.id\)/);
  });
  it('the table expands, scrolls to and focuses only the opened row', () => {
    const s = read('components', 'assignedPlan', 'AssignedPlansTable.tsx');
    expect(s).toMatch(/\[openInEditId\]/);
    expect(s).toMatch(/scrollIntoView/);
    expect(s).toMatch(/row\.id === openInEditId \? \(el\)/);
  });
  it('an already-mounted body follows startEditing too (#1813)', () => {
    const s = read('components', 'assignedPlan', 'AssignedPlanExpandedRow.tsx');
    expect(s).toMatch(/if \(startEditing\) setIsEditing\(true\)/);
  });
});
