import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

// Regression test for #627 — Promotion editing split by section.
//
// The context-menu Edit action must only make the main Promotion configuration
// (General / Suitable Membership Plans / Billing & Duration) editable, and each
// Benefit section must have its own Edit button with its own independent
// Save/Cancel. The whole Promotion must never become editable at once, and the
// inline/expandable UI must survive — no modal, no CrudModal.
//
// This repo has no component-test infra for apps/admin (see docs/architecture.md's
// TL;DR), so — like promotions-charge-benefits-removed.test.ts (#626) — this pins
// the structure down by scanning the page source and the locale files.

const LOCALES_DIR = join(__dirname, '..', '..', 'locales', 'base');
const PROMOTIONS_DIR = join(__dirname, '..', 'app', '[locale]', 'promotions');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;

type Messages = Record<string, unknown>;

function loadLocale(code: string): Messages {
  return JSON.parse(readFileSync(join(LOCALES_DIR, `${code}.json`), 'utf-8'));
}

function getNamespaceKeys(messages: Messages, namespace: string): Set<string> {
  const ns = messages[namespace];
  if (ns == null || typeof ns !== 'object') return new Set();
  return new Set(Object.keys(ns as Record<string, unknown>));
}

// Comments in the source deliberately name #627 and describe the old
// whole-Promotion edit mode, so every scan below runs on comment-free code.
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const pageSrc = stripComments(readFileSync(join(PROMOTIONS_DIR, 'page.tsx'), 'utf-8'));
const promotionsSources = readdirSync(PROMOTIONS_DIR)
  .filter((f) => f.endsWith('.tsx'))
  .map((file) => ({ file, src: stripComments(readFileSync(join(PROMOTIONS_DIR, file), 'utf-8')) }));

const locales = Object.fromEntries(LOCALE_CODES.map((c) => [c, loadLocale(c)])) as Record<
  (typeof LOCALE_CODES)[number],
  Messages
>;

// The four Benefit sections that each get their own Edit button.
const BENEFIT_SECTIONS = ['session', 'oneoff', 'periodical', 'membership_fee'] as const;

describe('Promotions: editing split by section (#627)', () => {
  it('tracks which single section of a card is editable', () => {
    // A card-wide `editingId` alone is what used to make the entire Promotion
    // editable — the section discriminator is what splits it up.
    expect(pageSrc).toContain('editingSection');
    expect(pageSrc).toContain('setEditingSection');
    for (const section of BENEFIT_SECTIONS) {
      expect(pageSrc, `no '${section}' section in the EditSection union`).toMatch(
        new RegExp(`type EditSection[\\s\\S]*?'${section}'`),
      );
    }
    expect(pageSrc, "EditSection must keep a 'main' member for the Promotion configuration")
      .toMatch(/type EditSection[\s\S]*?'main'/);
  });

  it('enters edit mode per section rather than for the whole card', () => {
    expect(pageSrc).toContain('function isEditingSection');
    expect(pageSrc).toContain('async function enterSectionEdit');
    // The context-menu Edit action opens the main configuration only.
    expect(pageSrc).toMatch(/async function enterEdit[\s\S]*?setEditingSection\('main'\)/);
  });

  it('gives every Benefit section its own Edit button', () => {
    expect(pageSrc).toContain('function renderSectionHeader');
    // The three Sellable-Item-keyed sections are driven off one config list…
    for (const section of ['session', 'oneoff', 'periodical']) {
      expect(pageSrc, `SELLABLE_BENEFIT_SECTIONS is missing '${section}'`).toMatch(
        new RegExp(`SELLABLE_BENEFIT_SECTIONS[\\s\\S]*?section: '${section}'`),
      );
    }
    expect(pageSrc).toMatch(/renderSellableBenefitSection[\s\S]*?enterSectionEdit\(promo, cfg\.section\)/);
    // …and Membership Fee Benefits, the singleton, has its own.
    expect(pageSrc).toMatch(/renderMembershipFeeSection[\s\S]*?enterSectionEdit\(promo, 'membership_fee'\)/);
  });

  it('saves and cancels each section independently', () => {
    expect(pageSrc).toContain('async function handleSaveMain');
    expect(pageSrc).toContain('async function handleSaveBenefitSection');
    // Saving the main configuration must not write any Benefit section.
    const saveMain = pageSrc.match(/async function handleSaveMain[\s\S]*?\n  }\n/)?.[0] ?? '';
    expect(saveMain).not.toBe('');
    for (const endpoint of ['session-benefits', 'oneoff-benefits', 'periodical-benefits']) {
      expect(saveMain, `handleSaveMain still writes /${endpoint}`).not.toContain(endpoint);
    }
    // Saving a Benefit section must not write the Promotion or its plans.
    const saveSection = pageSrc.match(/async function handleSaveBenefitSection[\s\S]*?\n  }\n/)?.[0] ?? '';
    expect(saveSection).not.toBe('');
    expect(saveSection).not.toContain('mainBody()');
    expect(saveSection).not.toContain('/plans');
    // Cancel is shared, and clears only the section currently being edited.
    expect(pageSrc).toMatch(/function cancelEdit[\s\S]*?setEditingSection\(null\)/);
  });

  it('keeps every Benefit section read-only until its own Edit button is used', () => {
    for (const renderer of [
      'renderSellableItemBenefitEditor',
      'renderSellableItemBenefitView',
      'renderMembershipFeeEditor',
      'renderMembershipFeeView',
    ]) {
      expect(pageSrc, `${renderer} is missing — a section cannot render both states`).toContain(`function ${renderer}`);
    }
    // Each section picks its renderer off its own editing state.
    expect(pageSrc).toMatch(/renderSellableBenefitSection[\s\S]*?isEditingSection\(promo\.id, cfg\.section\)/);
    expect(pageSrc).toMatch(/renderMembershipFeeSection[\s\S]*?isEditingSection\(promo\.id, 'membership_fee'\)/);
    // …and the main configuration off its own.
    expect(pageSrc).toMatch(/renderExpandedSection[\s\S]*?isEditingSection\(promo\.id, 'main'\)/);
  });

  it('still preserves the Membership Fee Benefit duration cap (#625)', () => {
    // The benefit is no longer saved alongside the Promotion, so shortening the
    // Promotion has to re-constrain an already-saved, over-long duration.
    expect(pageSrc).toContain('async function clampSavedMembershipFeeDuration');
    expect(pageSrc).toMatch(/async function handleSaveMain[\s\S]*?clampSavedMembershipFeeDuration\(promoId\)/);
    // The live cap follows whichever section is open: the unsaved form while
    // editing the main configuration, the saved Promotion otherwise.
    expect(pageSrc).toContain('function mfMaxDurationMonths');
    expect(pageSrc).toContain('promotionDurationFromPromo');
  });

  it('introduces no modal for Promotion editing', () => {
    for (const { file, src } of promotionsSources) {
      expect(src, `${file} introduces a CrudModal for Promotion editing`).not.toContain('CrudModal');
    }
    // The only modal on this page stays the read-only Details dialog.
    expect(pageSrc).toContain('PromotionDetailModal');
  });

  it('has the section Edit button hint in every locale, with the namespace still in parity', () => {
    for (const code of LOCALE_CODES) {
      const keys = getNamespaceKeys(locales[code], 'promotions');
      expect(keys.has('edit'), `${code}.json is missing promotions.edit`).toBe(true);
      expect(keys.has('edit_busy_hint'), `${code}.json is missing promotions.edit_busy_hint`).toBe(true);
      expect(keys.has('save_changes'), `${code}.json is missing promotions.save_changes`).toBe(true);
      expect(keys.has('cancel'), `${code}.json is missing promotions.cancel`).toBe(true);
    }

    const enKeys = getNamespaceKeys(locales.en, 'promotions');
    for (const code of LOCALE_CODES) {
      if (code === 'en') continue;
      const keys = getNamespaceKeys(locales[code], 'promotions');
      expect([...enKeys].filter((k) => !keys.has(k)), `${code}.json is missing "promotions" keys`).toEqual([]);
      expect([...keys].filter((k) => !enKeys.has(k)), `${code}.json has stray "promotions" keys`).toEqual([]);
    }
  });
});
