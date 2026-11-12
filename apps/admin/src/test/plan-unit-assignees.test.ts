// #2657 stage 2 — the Assigned Plan card's Member column: an Individual Product line
// reads as one row per member who holds units of it, a Shared one as one row with no
// member, and the server's line totals are spread over the rows to the cent.
import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { memberAllocations, splitLineAmount } from '@/lib/planUnitAssignees';
import { productBenefitColumns } from '@/components/ProductBenefits';

const m = (member_id: number, name: string) => ({ member_id, name });
const DIR = join(__dirname, '..', 'components', 'assignedPlan');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('memberAllocations', () => {
  it('reads a Shared line (no per-unit assignee) as one row with no member and its whole quantity', () => {
    expect(memberAllocations({ quantity: 3, unit_assignees: null })).toEqual([{ member_id: null, member_name: null, quantity: 3 }]);
    expect(memberAllocations({ quantity: 2 })).toEqual([{ member_id: null, member_name: null, quantity: 2 }]);
  });
  it('reads an individual plan line as one row for its member', () => {
    expect(memberAllocations({ quantity: 1, unit_assignees: [m(10, 'Ana')] })).toEqual([{ member_id: 10, member_name: 'Ana', quantity: 1 }]);
  });
  it('reads a Duo line as one row per member, in first-held order, counting each member’s units', () => {
    expect(memberAllocations({ quantity: 3, unit_assignees: [m(11, 'Bea'), m(10, 'Ana'), m(11, 'Bea')] })).toEqual([
      { member_id: 11, member_name: 'Bea', quantity: 2 },
      { member_id: 10, member_name: 'Ana', quantity: 1 },
    ]);
  });
});

describe('splitLineAmount', () => {
  it('keeps a single row’s total and a missing total as they are', () => {
    expect(splitLineAmount(20, [2])).toEqual([20]);
    expect(splitLineAmount(null, [1, 1])).toEqual([null, null]);
  });
  it('spreads the total over the units and adds up to it to the cent', () => {
    expect(splitLineAmount(20, [1, 1])).toEqual([10, 10]);
    const parts = splitLineAmount(10, [1, 1, 1]) as number[];
    expect(parts).toEqual([3.34, 3.33, 3.33]);
    expect(Math.round(parts.reduce((s, x) => s + x, 0) * 100)).toBe(1000);
    expect(splitLineAmount(30, [2, 1])).toEqual([20, 10]);
  });
});

describe('the card wiring', () => {
  it('puts Member right after Product, only where a caller asks', () => {
    const keys = productBenefitColumns({ showFrequency: true, showAction: true, showPrices: true, showMember: true }).map((c) => c.key);
    expect(keys.slice(0, 3)).toEqual(['item', 'member', 'quantity']);
    expect(productBenefitColumns({ showFrequency: true, showAction: true, showPrices: true }).map((c) => c.key)).not.toContain('member');
  });
  it('renders the Member column on every grid of the card and no Family Members per Unit section', () => {
    const src = strip(readFileSync(join(DIR, 'AssignedPlanConfiguration.tsx'), 'utf-8'));
    expect(src.match(/\bshowMember\b/g)?.length).toBe(2);
    expect(src).toContain('toAllocationRows(');
    expect(src).not.toContain('PlanUnitAssignees');
    expect(src).not.toContain('unit_assignees_title');
    expect(existsSync(join(DIR, 'PlanUnitAssignees.tsx'))).toBe(false);
  });
  it('labels the column in every locale and drops the retired section’s keys', () => {
    for (const code of ['en', 'es', 'ca']) {
      const ns = JSON.parse(readFileSync(join(__dirname, '..', '..', 'locales', 'base', `${code}.json`), 'utf-8')).assigned_plans_page;
      expect(ns.col_benefit_member).toBeTruthy();
      expect(Object.keys(ns).filter((k) => k.startsWith('unit_assignees_'))).toEqual([]);
    }
  });
});
