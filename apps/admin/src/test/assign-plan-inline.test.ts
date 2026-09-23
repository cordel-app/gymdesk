import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';

// Regression test for #628 — Assign Plan to Member is inline, with Promotion
// selection.
//
// "Assign New Plan" must no longer open a modal: the assignment is configured
// in place inside the member's expanded row, and the inline editor carries a
// Promotions section whose selection enforces the `stackable` rule as it
// changes. This repo has no component-test infra for apps/admin (see
// docs/architecture.md's TL;DR), so — like promotions-section-editing.test.ts
// (#627) — this pins the structure down by scanning the source and the locale
// files.

const LOCALES_DIR = join(__dirname, '..', '..', 'locales', 'base');
const MEMBERS_DIR = join(__dirname, '..', 'app', '[locale]', 'members');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function read(file: string): string {
  return stripComments(readFileSync(join(MEMBERS_DIR, file), 'utf-8'));
}

const editorSrc = read('AssignPlanInlineEditor.tsx');
const expandedRowSrc = read('MemberExpandedRow.tsx');
// #634 moved the plan cards (and with them the per-plan action menu) into the
// MEMBERSHIP PLANS section component; the expanded row still owns the single
// `assigningFor` state the guard is derived from.
const plansSectionSrc = read('MemberMembershipPlans.tsx');

const PROMOTION_KEYS = [
  'assign_new_plan_section_promotions',
  'assign_new_plan_promotions_pick_plan',
  'assign_new_plan_promotions_loading',
  'assign_new_plan_promotions_none',
  'assign_new_plan_promotion_stackable',
  'assign_new_plan_promotion_non_stackable',
  'assign_new_plan_promotion_blocked_by_non_stackable',
  'assign_new_plan_promotion_blocked_non_stackable',
];

describe('Assign Plan to Member: inline editor (#628)', () => {
  it('no longer ships an Assign New Plan modal component', () => {
    expect(existsSync(join(MEMBERS_DIR, 'AssignNewPlanModal.tsx'))).toBe(false);
    for (const file of readdirSync(MEMBERS_DIR).filter((f) => f.endsWith('.tsx'))) {
      expect(read(file), `${file} still references AssignNewPlanModal`).not.toContain('AssignNewPlanModal');
    }
  });

  it('renders the editor inline inside the plan card it supersedes', () => {
    expect(expandedRowSrc).toContain('<AssignPlanInlineEditor');
    // Rendered per plan card, only for the card the action was opened from —
    // not once at the bottom of the row like the modal was.
    expect(expandedRowSrc).toContain('assigningFor?.id === m.id');
  });

  it('introduces no modal of its own', () => {
    for (const forbidden of ['CrudModal', 'overlayStyle', 'modalStyle']) {
      expect(editorSrc, `inline editor uses ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('offers only the promotions targeting the plan being assigned', () => {
    expect(editorSrc).toContain('membership_plan_id=${planId}');
    expect(editorSrc).toContain('lifecycle_status=active');
  });

  it('submits the selected promotions with the assignment', () => {
    expect(editorSrc).toContain('assign-new-plan');
    expect(editorSrc).toContain('promotion_ids: selectedPromotionIds');
  });

  it('enforces the stacking rules on the selection itself', () => {
    // A selected non-stackable promotion blocks every other promotion…
    expect(editorSrc).toContain('nonStackableSelected');
    // …and any selection at all blocks the non-stackable ones.
    expect(editorSrc).toMatch(/selected\.length > 0 && !isStackable\(p\)/);
    // Blocked promotions are disabled in place, not rejected on Save.
    expect(editorSrc).toContain('disabled={saving || blocked !== null}');
  });

  it('keeps a single assignment editor open at a time', () => {
    expect(expandedRowSrc).toContain('assignBusy={assigningFor !== null}');
    expect(plansSectionSrc).toContain('disabled: assignBusy');
  });

  it('renders the inline editor inside the plan card it supersedes', () => {
    // #634 §15 keeps this inline and additive-free: "Assign New Plan" is still
    // the supersede action, distinct from the section's "+ Add Membership Plan".
    expect(expandedRowSrc).toContain('<AssignPlanInlineEditor');
    expect(expandedRowSrc).toContain('assigningFor?.id === m.id');
  });

  it('defines every promotion-selection key in all locales', () => {
    for (const code of LOCALE_CODES) {
      const messages = JSON.parse(readFileSync(join(LOCALES_DIR, `${code}.json`), 'utf-8'));
      for (const key of PROMOTION_KEYS) {
        expect(messages.members?.[key], `${code}.json is missing members.${key}`).toBeTruthy();
      }
    }
  });
});
