import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import {
  cardSectionDividedStyle,
  cardSectionStyle,
  formControlStyle,
  formValueStyle,
  secondaryBtnSmall,
  secondaryBtnStyle,
} from '../components/formChrome';
import { primaryActionColors } from '../components/ui';

// Regression tests for #929 — the Member card wears the application's own
// chrome, declared once in `components/formChrome.ts`, in both of its modes.
//
// This repo has no component-test infra for apps/admin (see docs/architecture.md's
// TL;DR), so the structural assertions scan the source the way
// member-profile-layout.test.ts (#882) does, and the shared style objects are
// asserted directly.

const MEMBERS_DIR = join(__dirname, '..', 'app', '[locale]', 'members');

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function read(file: string): string {
  return stripComments(readFileSync(join(MEMBERS_DIR, file), 'utf-8'));
}

/** Every file the Member card is built from — the two halves and its sections. */
const CARD_FILES = [
  'MemberExpandedRow.tsx',
  'MemberEditForm.tsx',
  'MemberProfileLayout.tsx',
  'MemberMembershipPlans.tsx',
  'MemberAdditionalServices.tsx',
  // #1118 §12: the Products the Member bought, inside the same section.
  'MemberPurchasedProducts.tsx',
  'MemberBillingSimulation.tsx',
  'MemberPersonalTrainingSlots.tsx',
  // #1108 stage 2 §7: the Member window's own `[ Save & Pay ]` action area, which
  // sits under the tab panes rather than inside a section.
  'MemberSaveAndPaySection.tsx',
  'AssignPlanInlineEditor.tsx',
] as const;

const sources = new Map(CARD_FILES.map((f) => [f, read(f)] as const));

describe('Member card: one declaration of the chrome (#929)', () => {
  it('covers every file the card is built from', () => {
    // A section file added later must be listed above, or it can quietly grow
    // another copy of the same input and never be noticed.
    const present = readdirSync(MEMBERS_DIR).filter((f) => f.startsWith('Member') || f.startsWith('AssignPlan'));
    const unlisted = present.filter((f) => f.endsWith('.tsx') && !f.endsWith('Modal.tsx') && !CARD_FILES.includes(f as any));
    expect(unlisted, 'Member card file not covered by this test').toEqual([]);
  });

  it('declares no section header, field label or control box of its own', () => {
    for (const [file, src] of sources) {
      // The section header's own numbers (#929: `cardSectionLabelStyle`).
      expect(src, `${file} restates the section header`).not.toMatch(/fontSize: 11,\s*fontWeight: 700/);
      // The control box's own border (`formControlStyle`).
      expect(src, `${file} restates the input border`).not.toContain("border: '1px solid #d1d5db'");
      // And the card's own border (`innerCardStyle`).
      expect(src, `${file} restates the card border`).not.toContain("border: '1px solid #e8e8ed'");
    }
  });

  it('takes a primary action from the Theme rather than a colour of its own', () => {
    for (const [file, src] of sources) {
      expect(src, `${file} hardcodes the primary button colour`).not.toContain("'#6c63ff'");
      // `btnStyle()`'s own default is `--brand`, the sidebar's selected-item
      // colour — a primary action uses primaryBtnStyle/primaryBtnSmall (#912).
      expect(src, `${file} styles a primary action with btnStyle()`).not.toMatch(/\bbtnS(tyle|mall)\(/);
    }
    expect(primaryActionColors.background).toBe('var(--gd-primary-btn, #6c63ff)');
  });

  it('builds both modes of the Profile from the shared chrome', () => {
    for (const file of ['MemberExpandedRow.tsx', 'MemberEditForm.tsx'] as const) {
      expect(sources.get(file)).toContain("from '@/components/formChrome'");
    }
    // Both halves render the Profile in the same card, so switching modes swaps
    // the controls and moves nothing else (§3).
    expect(sources.get('MemberEditForm.tsx')).toContain('innerCardStyle');
    expect(sources.get('MemberExpandedRow.tsx')).toContain('innerCardStyle');
  });

  it('separates the card\'s sections with the shared rule, and never the first one', () => {
    const expanded = sources.get('MemberExpandedRow.tsx')!;
    expect(expanded).toContain('cardSectionDividedStyle');
    expect(expanded).toContain("<Section label={t('members.section_profile')} divider={false}>");
    expect(cardSectionDividedStyle.borderTop).toBe('1px solid var(--gd-card-border, #e8e8ed)');
    expect(cardSectionStyle.borderTop).toBeUndefined();
    // One spacing decision, so a section cannot set a margin of its own.
    expect(cardSectionDividedStyle.marginBottom).toBe(cardSectionStyle.marginBottom);
  });
});

describe('Member card: a value sits where its input sits (#929)', () => {
  it('gives the read-only value the control box\'s inset and type', () => {
    expect(formValueStyle.padding).toBe(formControlStyle.padding);
    expect(formValueStyle.fontSize).toBe(formControlStyle.fontSize);
    // A transparent border of the same width, so the text does not shift by the
    // border's pixel when Edit opens.
    expect(formValueStyle.border).toBe('1px solid transparent');
  });

  it('keeps free text wrapping instead of widening the card', () => {
    expect(formValueStyle.whiteSpace).toBe('pre-wrap');
    expect(formValueStyle.overflowWrap).toBe('anywhere');
  });
});

describe('Member card: the two buttons of a pair are one pair (#929 §5)', () => {
  it('sizes a secondary action like the primary one beside it', () => {
    expect(secondaryBtnStyle.padding).toBe('9px 18px');
    expect(secondaryBtnStyle.fontSize).toBe(15);
    expect(secondaryBtnSmall.padding).toBe('6px 12px');
    expect(secondaryBtnSmall.fontSize).toBe(13);
    // Same radius as every other control, so a row of them lines up.
    expect(secondaryBtnStyle.borderRadius).toBe(6);
    expect(secondaryBtnSmall.borderRadius).toBe(6);
  });
});
