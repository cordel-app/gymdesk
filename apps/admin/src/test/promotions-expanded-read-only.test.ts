import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// #897 — a Promotion is read-only until Edit mode is entered from the context
// menu.
//
//   Expanded        → the COMPLETE Promotion, read-only, no Edit button in it
//   ⋮ → Edit        → the main configuration becomes a form AND every Benefit
//                     section's own Edit button appears
//   Cancel / Save   → back to the read-only expanded card, buttons gone
//
// #627 split Promotion editing into independently saved sections and gave each
// one its own Edit button; those buttons were reachable straight from the
// read-only card, which is what this ticket removes. The per-section saves
// themselves are unchanged — promotions-section-editing.test.ts still guards
// them — so everything here is about *when* an editor is reachable.
//
// apps/admin has no component-test infra (docs/architecture.md's TL;DR), so the
// structure is pinned by scanning the page source, the way
// plans-expanded-read-only.test.ts does for the same rule on Membership Plans.

const PAGE = join(__dirname, '..', 'app', '[locale]', 'promotions', 'page.tsx');

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const pageSrc = stripComments(readFileSync(PAGE, 'utf-8'));

/** The body of a top-level function of the page component. */
function fn(name: string): string {
  const match = pageSrc.match(new RegExp(`(async )?function ${name}\\b[\\s\\S]*?\\n  }\\n`));
  expect(match?.[0], `function ${name} not found`).toBeTruthy();
  return match![0];
}

/** The four sections of an expanded Promotion that carry their own editor. */
const BENEFIT_SECTIONS = ['session', 'oneoff', 'periodical', 'membership_fee'] as const;

describe('Promotions: component Edit actions live inside Edit mode (#897)', () => {
  it('has one card-level Edit mode, entered only from the context menu', () => {
    expect(pageSrc).toContain('function isEditingCard');
    // `editingId` is that mode. Only the context-menu action and the
    // new-Promotion row may set it — a Benefit section's Edit button must not,
    // because it is reachable only from inside the mode already.
    expect(fn('enterEdit')).toContain('setEditingId(promo.id)');
    expect(fn('enterSectionEdit'), 'a section Edit button must not enter Edit mode itself')
      .not.toContain('setEditingId');
    const menuEdit = pageSrc.match(/label: t\('edit'\),[\s\S]*?\},/)?.[0] ?? '';
    expect(menuEdit, "the context menu's Edit action still opens enterEdit").toContain('enterEdit(promo)');
  });

  it('shows a section Edit button only while the card is in Edit mode', () => {
    // Both section shells gate their Edit callback on the card's Edit mode and
    // pass `null` otherwise, which is what removes the button from the DOM
    // rather than only disabling it.
    expect(fn('renderSellableBenefitSection')).toMatch(
      /isEditingCard\(promo\.id\) && !editing \? \(\) => enterSectionEdit\(promo, cfg\.section\) : null/,
    );
    expect(fn('renderMembershipFeeSection')).toMatch(
      /isEditingCard\(promo\.id\) && !editing \? \(\) => enterSectionEdit\(promo, 'membership_fee'\) : null/,
    );
    // The shell renders the button only when it is handed one.
    expect(fn('renderSectionHeader')).toMatch(/onEdit && \(/);
  });

  it('keeps the existing Edit button, its placement and its label', () => {
    const header = fn('renderSectionHeader');
    // #901 moved the button itself into the shared `SectionEditButton`, which
    // the Membership Plan card renders too and which takes its colours from the
    // Theme instead of the lilac literal this page used to pass to `btnSmall`.
    // The read-only styling for a role that may not write lives in there as
    // well; what stays this page's is the label, the disabled decision and the
    // title-left / button-right header.
    expect(header, 'the section Edit button is no longer the shared one').toContain('<SectionEditButton');
    expect(header, 'the section Edit button lost its label').toContain("label={t('edit')}");
    expect(header, 'the section Edit button lost its disabled state').toContain('disabled={disabled}');
    expect(header, 'the header is no longer title-left / button-right')
      .toContain("justifyContent: 'space-between'");
  });

  it('renders the main configuration as a form for as long as Edit mode lasts', () => {
    // Read-only expanded → renderMainView; Edit mode → the form plus its own
    // Save/Cancel. One body, two renderings (#627's rule, now keyed on the card).
    expect(fn('renderExpandedSection')).toMatch(
      /const editing = isEditingCard\(promo\.id\);[\s\S]*?editing[\s\S]*?renderMainFields\(\)[\s\S]*?renderMainView\(promo\)/,
    );
  });

  it('returns to the read-only expanded card when Edit mode ends', () => {
    // Cancelling Edit mode closes every section editor with it and leaves the
    // card expanded — only the never-created new row collapses.
    const cancel = fn('cancelEdit');
    expect(cancel).toContain('setEditingId(null)');
    expect(cancel).toContain('setOpenSection(null)');
    expect(cancel).toMatch(/editingId === NEW_ID[\s\S]*?setExpandedId\(null\)/);
    expect(
      cancel.replace(/if \(editingId === NEW_ID\) \{[\s\S]*?\}/, ''),
      'cancelling Edit mode on a saved Promotion must not collapse the card',
    ).not.toContain('setExpandedId(null)');
    // Saving the main configuration ends Edit mode the same way.
    const saveMain = fn('handleSaveMain');
    expect(saveMain).toContain('finishEdit()');
    expect(saveMain, 'saving must not collapse the card either').not.toContain('setExpandedId(null)');
    expect(fn('finishEdit')).toContain('setOpenSection(null)');
  });

  it('closes only the section being saved or cancelled, staying in Edit mode', () => {
    const cancelSection = fn('cancelSectionEdit');
    expect(cancelSection).toContain('setOpenSection(null)');
    expect(cancelSection, 'cancelling one section must not leave Edit mode').not.toContain('setEditingId');
    const saveSection = fn('handleSaveBenefitSection');
    expect(saveSection).toContain('cancelSectionEdit()');
    expect(saveSection, 'saving one section must not leave Edit mode').not.toContain('finishEdit()');
  });

  it('gives a section editor its own error line, apart from the main form', () => {
    expect(pageSrc).toContain('setSectionError');
    for (const call of [
      /handleSaveBenefitSection\(promo\.id, cfg\.section\),\s*\{ onCancel: cancelSectionEdit, error: sectionError \}/,
      /handleSaveBenefitSection\(promo\.id, 'membership_fee'\),\s*\{ onCancel: cancelSectionEdit, error: sectionError \}/,
    ]) {
      expect(pageSrc).toMatch(call);
    }
  });

  it('leaves the read-only presentation and the section set alone', () => {
    // §6: nothing about the read-only card changes — it still renders the same
    // views, in the same order, through the same renderers.
    for (const renderer of [
      'renderMainView',
      'renderSellableItemBenefitView',
      'renderMembershipFeeView',
      'renderTimeline',
    ]) {
      expect(pageSrc, `${renderer} is gone — the read-only card changed shape`).toContain(`function ${renderer}`);
    }
    const expanded = fn('renderExpandedSection');
    for (const section of ['renderSellableBenefitSection', 'renderMembershipFeeSection', 'renderTimeline']) {
      expect(expanded, `${section} no longer renders inside the expanded card`).toContain(section);
    }
    for (const section of BENEFIT_SECTIONS) {
      expect(pageSrc, `the '${section}' section is gone`).toMatch(
        new RegExp(`type BenefitSection[\\s\\S]*?'${section}'`),
      );
    }
    // The Promotion is still never editable as a whole, and still never modal.
    expect(pageSrc).not.toContain('CrudModal');
  });
});
