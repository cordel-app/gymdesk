import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  CardSectionHeader,
  cardSectionActionsStyle,
  cardSectionHeaderStyle,
  cardSectionTitleStyle,
} from '@/components/CardSectionHeader';
import { cardSectionLabelStyle } from '@/components/formChrome';

// #963 — a subsection's contextual actions sit immediately after its title.
//
// Both configuration cards used to lay their section header out with
// `justifyContent: 'space-between'`, which on a wide screen puts a card's width
// of empty space between `BILLING & DURATION` and the `[ Edit ]` that opens it,
// and pushed each section editor's Save/Cancel to the far right under the fields
// — so while a section was open its header read as having no actions at all.
//
// apps/admin has no component-test infra (docs/architecture.md's TL;DR), so —
// like section-edit-button.test.ts and plans-expanded-read-only.test.ts — the
// shared style objects are asserted directly and each page's wiring is pinned by
// scanning its source.

const SRC = join(__dirname, '..');
const COMPONENT = join(SRC, 'components', 'CardSectionHeader.tsx');
const PLANS_PAGE = join(SRC, 'app', '[locale]', 'plans', 'page.tsx');
const PROMOTIONS_PAGE = join(SRC, 'app', '[locale]', 'promotions', 'page.tsx');
const ASSIGNED_PLANS = [
  join(SRC, 'app', '[locale]', 'memberships', 'page.tsx'),
  join(SRC, 'components', 'assignedPlan', 'AssignedPlanExpandedRow.tsx'),
  join(SRC, 'components', 'assignedPlan', 'AssignedPlanConfiguration.tsx'),
  join(SRC, 'components', 'assignedPlan', 'AssignedPlanPromotions.tsx'),
];

// Every file's comments quote the layout that was removed, so the scans below
// run on comment-free code.
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const read = (path: string) => stripComments(readFileSync(path, 'utf-8'));

const componentSrc = read(COMPONENT);
const plansSrc = read(PLANS_PAGE);
const promotionsSrc = read(PROMOTIONS_PAGE);
const assignedSrcs = ASSIGNED_PLANS.map(read);

describe('CardSectionHeader: title first, action beside it (#963 core design rule)', () => {
  it('lays the row out left to right and never spaces the action away', () => {
    expect(cardSectionHeaderStyle.display).toBe('flex');
    expect(cardSectionHeaderStyle.alignItems).toBe('center');
    // The whole point of the ticket: no `space-between`, and no `marginLeft:
    // auto` smuggled in to reproduce it.
    expect(cardSectionHeaderStyle.justifyContent).toBeUndefined();
    expect(cardSectionActionsStyle.marginLeft).toBeUndefined();
    expect(cardSectionHeaderStyle.gap).toBe(10);
  });

  it('stays readable at phone width instead of overflowing sideways', () => {
    // Responsive behaviour: a two-button pair drops under the title rather than
    // widening the card, which is what `space-between` on a narrow card did.
    expect(cardSectionHeaderStyle.flexWrap).toBe('wrap');
    expect(cardSectionActionsStyle.flexWrap).toBe('wrap');
  });

  it('renders the title as a child, so no caller can put an action before it', () => {
    const title = componentSrc.indexOf('{title}');
    const actions = componentSrc.indexOf('{actions ?');
    expect(title).toBeGreaterThan(-1);
    expect(actions).toBeGreaterThan(title);
    expect(componentSrc).toContain('title: string;');
  });

  it('takes the heading from formChrome rather than respelling it (#929)', () => {
    // A fourth spelling of 11px / 700 / uppercase is exactly what `formChrome`
    // exists to prevent; the only thing this module adds is the row.
    for (const key of ['fontSize', 'fontWeight', 'color', 'textTransform', 'letterSpacing'] as const) {
      expect(cardSectionTitleStyle[key]).toBe(cardSectionLabelStyle[key]);
    }
    // The row owns the spacing below the header now.
    expect(cardSectionTitleStyle.marginBottom).toBe(0);
    expect(cardSectionHeaderStyle.marginBottom).toBe(8);
  });

  it('is presentational: no locale key, no permission, no colour of its own', () => {
    expect(typeof CardSectionHeader).toBe('function');
    expect(componentSrc).not.toContain('useTranslations');
    expect(componentSrc).not.toContain('canWrite');
    expect(componentSrc.match(/#[0-9a-fA-F]{3,8}/g) ?? []).toEqual([]);
  });
});

describe('Membership Plans: every subsection action is beside its title (#963)', () => {
  it('renders the shared header from the one section shell', () => {
    expect(plansSrc).toContain("import { CardSectionHeader, cardSectionTitleStyle } from '@/components/CardSectionHeader'");
    expect(plansSrc).toMatch(
      /function SectionHeader\(\{ title, action \}[\s\S]*?<div style=\{subSectionSt\}>\s*<CardSectionHeader title=\{title\} actions=\{action\} \/>/,
    );
    // The hairline between sections is still the page's; only the header row moved.
    expect(plansSrc).toContain('const subSectionSt');
  });

  it('declares no section header layout of its own any more', () => {
    // The two survivors are the page's own title bar and the collapsible Price
    // History card, whose chevron sits at the far edge by design (#881).
    expect(plansSrc.match(/justifyContent: 'space-between'/g) ?? []).toHaveLength(2);
    expect(plansSrc).toContain('const sectionLabelSt: React.CSSProperties = cardSectionTitleStyle;');
  });

  it('puts each section editor\'s Save/Cancel in that section\'s header', () => {
    for (const open of [
      'isEditing && pricingForPlanId === plan.id ? sectionSaveActions({',
      'isEditing && durationEditForPlanId === plan.id ? sectionSaveActions({',
      'isEditing && isEditingBenefit(plan.id, section) ? sectionSaveActions({',
      'isEditing && centersForPlanId === plan.id ? sectionSaveActions({',
    ]) {
      expect(plansSrc, `${open} — this section's actions are not in its header`).toContain(open);
    }
    // One pair per open section, and the four sections that have an editor.
    expect(plansSrc.match(/\? sectionSaveActions\(\{/g) ?? []).toHaveLength(4);
  });

  it('leaves no Save/Cancel pair at the far right under a section editor', () => {
    for (const gone of [
      'onClick={closePricingForm} style={btnSmall(',
      'onClick={cancelDurationEdit} style={btnSmall(',
      'onClick={cancelBenefitEdit} style={btnSmall(',
      'onClick={handleSaveCenters} style={btnSmall(',
    ]) {
      expect(plansSrc, `${gone} — a section's buttons are still under its fields`).not.toContain(gone);
    }
  });

  it('keeps the same buttons, handlers, labels and saving state', () => {
    // Styling and behaviour are unchanged: the existing neutral Cancel and the
    // existing themed Save, with each section's own label and `saving` flag.
    expect(plansSrc).toContain("<button onClick={onCancel} style={btnSmall('#888')}>{t('plans.cancel')}</button>");
    expect(plansSrc).toContain('<button onClick={onSave} disabled={saving} style={btnSmall()}>');
    expect(plansSrc).toContain("{saving ? t('plans.saving') : saveLabel}");
    // PRICING says `Save`, every other section `Save changes` — as before.
    expect(plansSrc).toContain("saveLabel: t('plans.save'),");
    expect(plansSrc.match(/saveLabel: t\('plans\.save_changes'\),/g) ?? []).toHaveLength(3);
    expect(plansSrc).toContain('saving: pricingSaving,');
    expect(plansSrc).toContain('saving: durationSaving,');
    expect(plansSrc).toContain('saving: benefitSaving,');
  });

  it('moves PRICING\'s own apply-to-assigned action beside the PRICING title too', () => {
    // It is a PRICING action and it was the other button sitting at the far
    // right. It still belongs to Edit mode, since it reprices existing members.
    expect(plansSrc).toMatch(
      /isEditing && pricingForPlanId !== plan\.id \? \([\s\S]*?<SectionEditButton[\s\S]*?plan\.current_price != null && \([\s\S]*?apply_price_to_assigned/,
    );
    expect(plansSrc).not.toMatch(/justifyContent: 'flex-end', margin: '6px 0 10px'/);
  });

  it('keeps the card\'s own main form pair at the end of the form', () => {
    // GENERAL is the card's form, not a subsection with a contextual action, so
    // its Save/Cancel stays under the fields it commits — the app's form
    // convention (`formActionsRowStyle`), and the one pair per card.
    expect(plansSrc).toMatch(
      /justifyContent: 'flex-end' \}\}>\s*<button onClick=\{cancelEdit\}[\s\S]*?handleInlineSave\(plan\)/,
    );
  });

  it('changes no permission gate', () => {
    expect(plansSrc.match(/<SectionEditButton/g) ?? []).toHaveLength(4);
    expect(plansSrc.match(/disabled=\{!canWrite\}/g) ?? []).not.toHaveLength(0);
  });
});

describe('Promotions: every subsection action is beside its title (#963)', () => {
  it('renders the shared header from the one section shell', () => {
    expect(promotionsSrc).toContain("import { CardSectionHeader } from '@/components/CardSectionHeader'");
    expect(promotionsSrc).toMatch(/function renderSectionHeader\([\s\S]*?<CardSectionHeader/);
  });

  it('routes every heading of the card through it', () => {
    // Applies To, Billing & Duration, Suitable Membership Plans, the three
    // Benefit sections, the Membership Fee Benefit, General, and the two
    // projections — no `<p style={sectionLabelSt}>` is left anywhere, and the
    // page no longer declares that style at all.
    expect(promotionsSrc).not.toContain('sectionLabelSt');
    expect((promotionsSrc.match(/<CardSectionHeader/g) ?? []).length).toBeGreaterThanOrEqual(10);
    expect(promotionsSrc.match(/justifyContent: 'space-between'/g) ?? []).toHaveLength(1);
  });

  it('gives Suitable Membership Plans\' Retry the same treatment', () => {
    expect(promotionsSrc).toMatch(
      /<CardSectionHeader\s*title=\{t\('section_suitable_plans'\)\}\s*actions=\{plansStatus === 'error' \? \([\s\S]*?loadPlans/,
    );
  });

  it('puts each section editor\'s Save/Cancel in that section\'s header', () => {
    expect(promotionsSrc).toContain(
      'function renderSectionHeader(titleKey: string, onEdit: (() => void) | null, actions?: React.ReactNode)',
    );
    expect(promotionsSrc).toMatch(
      /sectionHeaderActions\(\(\) => handleSaveBenefitSection\(promo\.id, cfg\.section\), cancelSectionEdit\)/,
    );
    expect(promotionsSrc).toMatch(
      /sectionHeaderActions\(\(\) => handleSaveBenefitSection\(promo\.id, 'membership_fee'\), cancelSectionEdit\)/,
    );
    // The pair's error line stays in the body, under the fields it belongs to.
    expect(promotionsSrc.match(/renderSectionError\(sectionError\)/g) ?? []).toHaveLength(2);
  });

  it('keeps the same buttons, handlers, labels and saving state', () => {
    expect(promotionsSrc).toContain("<button onClick={onCancel} style={btnSmall('#888')}>{t('cancel')}</button>");
    expect(promotionsSrc).toContain('<button onClick={onSave} disabled={editSaving} style={primaryBtnSmall()}>');
    expect(promotionsSrc).toContain("{editSaving ? t('saving') : t('save_changes')}");
  });

  it('keeps the main configuration\'s own pair at the end of the form', () => {
    expect(promotionsSrc).toContain('function renderSectionActions(onSave: () => void)');
    expect(promotionsSrc).toMatch(/renderSectionActions[\s\S]*?justifyContent: 'flex-end', marginTop: 16/);
  });

  it('still hides a section\'s Edit button outside the card\'s Edit mode (#897)', () => {
    expect(promotionsSrc).toContain('isEditingCard(promo.id) && !editing ?');
    // A section with neither an `onEdit` nor a pair hands the header no actions
    // at all, so the read-only card renders the title and nothing beside it.
    expect(promotionsSrc).toMatch(/const slot = onEdit[\s\S]*?: actions \?\? null;/);
    expect(promotionsSrc).toContain('disabled={disabled}');
  });
});

describe('Assigned Membership Plans are not touched (#963)', () => {
  it('takes no part in this change', () => {
    // Explicitly out of scope: the Assigned Plan card keeps its own action
    // model, so none of its files renders the shared header this ticket
    // introduced for the two catalogue cards.
    expect(assignedSrcs).toHaveLength(4);
    for (const [i, src] of assignedSrcs.entries()) {
      expect(src.length, `${ASSIGNED_PLANS[i]} did not load`).toBeGreaterThan(500);
      expect(src, `${ASSIGNED_PLANS[i]} now renders the shared section header`).not.toContain('CardSectionHeader');
    }
  });
});
