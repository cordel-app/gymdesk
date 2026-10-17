// #1725 — an assigned plan on the Member card has ONE `⋮` (the row's), which
// offers Edit for a Draft and opens the embedded body in Edit mode; the body
// draws no menu of its own when embedded.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');
const section = read('app/[locale]/members/MemberMembershipPlans.tsx');
const table = read('components/assignedPlan/AssignedPlansTable.tsx');
const body = read('components/assignedPlan/AssignedPlanExpandedRow.tsx');

describe('#1725 single plan menu', () => {
  it('offers Edit on a Draft from the row menu through the table helper', () => {
    expect(section).toMatch(/plan\.status === 'draft'[\s\S]{0,200}helpers\.startEdit\(plan\.id\)/);
    expect(table).toContain('rowActions(row, { startEdit })');
  });
  it('the table asks the body to enter Edit mode with a token', () => {
    expect(table).toContain('editToken={editTokens[row.id] ?? 0}');
    expect(body).toMatch(/if \(editToken > 0\) setIsEditing\(true\)/);
  });
  it('an embedded body draws no inner menu', () => {
    expect(body).toMatch(/\{!embedded && \([\s\S]{0,700}<ContextMenu/);
  });
});
