import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { sectionEditButtonStyle } from '@/components/SectionEditButton';

// #901 — the subsection `Edit` action is one component, shared by the Membership
// Plan card and the Promotion card, and its colours come from the Theme's
// existing Buttons group rather than from a hardcoded lilac.
//
// Before this ticket Promotions rendered a filled `btnSmall('#6c63ff')` and
// Plans a bare `linkBtn` text link for the same action on two screens that are
// otherwise deliberately identical. apps/admin has no component-test infra
// (docs/architecture.md's TL;DR), so — like plans-expanded-read-only.test.ts and
// promotions-section-editing.test.ts — the wiring is pinned by scanning the page
// sources, while the shared style object is asserted directly.

const SRC = join(__dirname, '..');
const COMPONENT = join(SRC, 'components', 'SectionEditButton.tsx');
const PLANS_PAGE = join(SRC, 'app', '[locale]', 'plans', 'page.tsx');
const PROMOTIONS_PAGE = join(SRC, 'app', '[locale]', 'promotions', 'page.tsx');

// The comments in all three files name the old hardcoded colour to explain what
// was removed, so every scan below runs on comment-free code.
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const read = (path: string) => stripComments(readFileSync(path, 'utf-8'));

const componentSrc = read(COMPONENT);
const plansSrc = read(PLANS_PAGE);
const promotionsSrc = read(PROMOTIONS_PAGE);

describe('SectionEditButton: theme-derived colours (#901 §3, §4, §5)', () => {
  it('takes its background and text colour from the Theme Buttons group', () => {
    // `primaryButton` / `primaryButtonText` already exist as Theme settings and
    // `applyTokens` already writes these two variables — §4 asks for that
    // setting to be reused rather than a new one added for these buttons, and
    // §5 for the label colour to come from the same place.
    expect(sectionEditButtonStyle.background).toBe('var(--gd-primary-btn, #6c63ff)');
    expect(sectionEditButtonStyle.color).toBe('var(--gd-primary-btn-text, #ffffff)');
  });

  it('keeps the filled Promotions geometry the Plans link did not have', () => {
    expect(sectionEditButtonStyle.border).toBe('none');
    expect(sectionEditButtonStyle.borderRadius).toBe(4);
    expect(sectionEditButtonStyle.padding).toBe('6px 12px');
    expect(sectionEditButtonStyle.fontSize).toBe(13);
    expect(sectionEditButtonStyle.cursor).toBe('pointer');
  });

  it('spells the colours only as CSS var() fallbacks', () => {
    // A bare `#6c63ff` or `#fff` anywhere else in the module would be a second
    // source of truth that a themed gym could not move.
    const colourLiterals = componentSrc.match(/#[0-9a-fA-F]{3,8}/g) ?? [];
    expect(colourLiterals).toEqual(['#6c63ff', '#ffffff']);
    for (const literal of colourLiterals) {
      expect(componentSrc).toContain(`, ${literal})`);
    }
  });

  it('carries no locale key and no permission decision of its own', () => {
    // Each page owns the label (a Plan says "Edit pricing", a Promotion "Edit")
    // and owns `disabled` / `title`, so the shared button cannot decide either.
    expect(componentSrc).not.toContain('useTranslations');
    expect(componentSrc).not.toContain('canWrite');
    expect(componentSrc).toContain('label: string');
    expect(componentSrc).toContain('readOnlyStyle(sectionEditButtonStyle, disabled)');
  });
});

describe('Membership Plans and Promotions share it (#901 §1, §2, §7)', () => {
  it('is what both pages render', () => {
    for (const src of [plansSrc, promotionsSrc]) {
      expect(src).toContain("import { SectionEditButton } from '@/components/SectionEditButton'");
      expect(src).toContain('<SectionEditButton');
    }
  });

  it('leaves no page-local Edit button styling behind', () => {
    // The two shapes this ticket unified: Promotions' hardcoded filled button
    // and Plans' brand-coloured text link.
    expect(promotionsSrc).not.toContain("btnSmall('#6c63ff'), disabled");
    expect(plansSrc).not.toContain('readOnlyStyle(linkBtn');
    expect(plansSrc).not.toContain('const linkBtn');
  });

  it('covers every Membership Plan subsection that had an Edit action', () => {
    // PRICING, BILLING & DURATION, the three Sellable Item benefit sections
    // (one JSX site inside `BENEFIT_SECTIONS.map`) and CENTERS.
    expect(plansSrc.match(/<SectionEditButton/g) ?? []).toHaveLength(4);
    for (const label of ["label={t('plans.edit_pricing')}", "label={t('plans.edit')}"]) {
      expect(plansSrc).toContain(label);
    }
  });

  it('keeps the Promotion card rendering it from the one section header', () => {
    expect(promotionsSrc.match(/<SectionEditButton/g) ?? []).toHaveLength(1);
    expect(promotionsSrc).toContain("label={t('edit')}");
  });
});

describe('Read-only vs Edit mode is unchanged (#901 §6)', () => {
  it('Promotions still hand the section header a null action outside Edit mode', () => {
    // #897: the button must be absent, not disabled, on a read-only card.
    expect(promotionsSrc).toContain('function renderSectionHeader(titleKey: string, onEdit: (() => void) | null)');
    expect(promotionsSrc).toContain('isEditingCard(promo.id) && !editing ?');
    expect(promotionsSrc).toContain('{onEdit && (');
  });

  it('every Plan subsection Edit button stays behind the card Edit mode', () => {
    // #816: each `action` slot is gated on `isEditing`, so the read-only
    // expanded card carries no Edit affordance at all.
    for (const gate of [
      'isEditing && pricingForPlanId !== plan.id ?',
      'isEditing && durationEditForPlanId !== plan.id ?',
      'isEditing && !isEditingBenefit(plan.id, section) ?',
      'isEditing && centersForPlanId !== plan.id ?',
    ]) {
      expect(plansSrc).toContain(gate);
    }
  });

  it('still disables rather than hides the button for a read-only role', () => {
    expect(plansSrc).toContain('disabled={!canWrite}');
    expect(promotionsSrc).toContain('disabled={disabled}');
  });
});
