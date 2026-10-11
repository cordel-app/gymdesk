import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

// #1460 — both plan-assignment entry points are inline and carry no Benefits
// checklist. Source scan, like assign-plan-inline.test.ts (no component infra).
const APP = join(__dirname, '..', 'app', '[locale]');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const read = (...p: string[]) => strip(readFileSync(join(APP, ...p), 'utf-8'));

const plansEditor = read('plans', 'AssignPlanToMembersEditor.tsx');
const plansPage = read('plans', 'page.tsx');
const membersEditor = read('members', 'AssignPlanInlineEditor.tsx');

describe('Assign plan inline, no Benefits checklist (#1460)', () => {
  it('the Plans page has no Assign modal any more', () => {
    expect(existsSync(join(APP, 'plans', 'AssignPlanModal.tsx'))).toBe(false);
    expect(plansPage).not.toContain('AssignPlanModal');
    expect(plansPage).toContain('<AssignPlanToMembersEditor');
    for (const f of ['overlayStyle', 'modalStyle', 'CrudModal']) expect(plansEditor).not.toContain(f);
  });

  it('neither editor offers or sends benefits', () => {
    expect(read('members', 'MemberMembershipPlans.tsx')).toContain('<AssignPlanToMembersEditor');
    for (const src of [plansEditor, membersEditor]) {
      expect(src).not.toContain('declined');
      expect(src).not.toContain('-benefits');
      expect(src).not.toContain('assign_new_plan_section_benefits');
    }
  });

  it('the Plans editor keeps member search, start date and replace confirmation', () => {
    expect(plansEditor).toContain('MemberSearchInput');
    expect(plansEditor).toContain('starts_at: startsAt');
    expect(plansEditor).toContain('...(confirmReplacement ? { confirm: true } : {})');
  });
});
