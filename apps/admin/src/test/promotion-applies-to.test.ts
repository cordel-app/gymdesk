import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  DEFAULT_PROMOTION_TARGET,
  PROMOTION_TARGET_OPTIONS,
  promotionTargetOrDefault,
  targetsMembershipPlan,
} from '@/lib/promotionTargets';

// #926 — `APPLIES TO` on a Promotion: Membership Plan or Sellable Item, and the
// two Membership-Plan-specific sections are hidden for the latter.
//
// apps/admin has no component-test infra (docs/architecture.md's TL;DR), so the
// pure mirror is exercised directly and the page wiring is pinned by scanning
// the source, the way promotion-benefit-columns.test.ts does.

const SRC = join(__dirname, '..');
const LOCALES_DIR = join(__dirname, '..', '..', 'locales', 'base');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const promotionsSrc = stripComments(
  readFileSync(join(SRC, 'app', '[locale]', 'promotions', 'page.tsx'), 'utf-8'),
);
const detailSrc = stripComments(
  readFileSync(join(SRC, 'app', '[locale]', 'promotions', 'PromotionDetailModal.tsx'), 'utf-8'),
);

describe('the target itself', () => {
  it('offers the two mutually exclusive options the ticket names', () => {
    expect(PROMOTION_TARGET_OPTIONS.map((o) => o.value)).toEqual(['membership_plan', 'sellable_item']);
  });

  it('defaults to the behaviour every Promotion had before the flag', () => {
    expect(DEFAULT_PROMOTION_TARGET).toBe('membership_plan');
    expect(targetsMembershipPlan(DEFAULT_PROMOTION_TARGET)).toBe(true);
  });

  it('reads an absent or unknown stored value as the default, never as "no Plan"', () => {
    // A Promotion row from before migration 204, or a response that omits the
    // column: the two sections have to stay visible rather than vanish.
    for (const absent of [null, undefined, '', 'bundle']) {
      expect(promotionTargetOrDefault(absent)).toBe('membership_plan');
      expect(targetsMembershipPlan(absent)).toBe(true);
    }
  });

  it('is the one predicate the page asks — no second list and no inline comparison', () => {
    expect(promotionsSrc).toContain("from '@/lib/promotionTargets'");
    expect(promotionsSrc).toContain('targetsMembershipPlan(');
    // A literal comparison against the stored value would be the second
    // implementation this module exists to prevent.
    expect(promotionsSrc).not.toContain("=== 'sellable_item'");
    expect(promotionsSrc).not.toContain("applies_to === 'membership_plan'");
  });
});

describe('the radio group', () => {
  it('renders one radio per declared option, from the declaration', () => {
    expect(promotionsSrc).toContain('PROMOTION_TARGET_OPTIONS.map');
    expect(promotionsSrc).toContain('type="radio"');
    // One group name, which is what makes the options mutually exclusive.
    expect(promotionsSrc).toContain('name="promotion-applies-to"');
    expect(promotionsSrc).not.toContain('applies_to: true');
  });

  it('submits the target with the main configuration', () => {
    expect(promotionsSrc).toContain('applies_to: editForm.applies_to');
  });
});

describe('the Membership-Plan-specific sections', () => {
  it('gates both of them, in the form and in the read-only view', () => {
    // Seven call sites, and every one of them this predicate's: the card's
    // effective-target helper, the radio's own handler, the two save paths, and
    // the three JSX gates (Suitable Membership Plans in the form and in the
    // read-only view, the Membership Fee editor in the create form — the
    // expanded card's goes through the helper). Each gate is an `&&`, so the
    // section is *absent* rather than disabled.
    expect(promotionsSrc.match(/targetsMembershipPlan\(/g) ?? []).toHaveLength(7);
    expect(promotionsSrc).toContain('{targetsMembershipPlan(editForm.applies_to) && (');
    expect(promotionsSrc).toContain('{targetsMembershipPlan(target) && (');
    expect(promotionsSrc).toContain('{cardTargetsMembershipPlan(promo) && renderMembershipFeeSection(promo)}');
  });

  it('asks the radio\'s value while editing, so switching updates the card at once (§4)', () => {
    expect(promotionsSrc).toContain(
      'return targetsMembershipPlan(isEditingCard(promo.id) ? editForm.applies_to : promo.applies_to);',
    );
  });

  it('stops writing Suitable Membership Plans instead of writing it empty (§4)', () => {
    // The `PUT` is replace-all: sending the hidden draft would discard the
    // gym's selection, which is the silent migration the ticket forbids.
    const save = promotionsSrc.slice(promotionsSrc.indexOf('async function handleSaveMain'));
    const gate = save.indexOf('targetsMembershipPlan(editForm.applies_to)');
    const plansPut = save.indexOf('/plans`');
    expect(gate).toBeGreaterThan(-1);
    expect(plansPut).toBeGreaterThan(gate);
    expect(promotionsSrc).not.toContain('membership_plan_ids: [] ');
  });

  it('does not write the Membership Fee Benefit the create form did not show', () => {
    expect(promotionsSrc).toContain('if (forPlan && mfDraft)');
  });
});

describe('the rest of the card', () => {
  it('keeps the sections that are not Plan-specific', () => {
    // Billing & Duration is the Promotion's own Free/Paid/Bonus timeline (it
    // also bounds a grant's coverage), the Example Timeline is a read-only
    // projection of it, and the Billing Event Simulation carries no Membership
    // Fee line by design (#922). None of the three is gated on the target.
    expect(promotionsSrc).toContain("{renderTimeline()}");
    expect(promotionsSrc).toContain('{renderBillingEventSimulation(promo)}');
    expect(promotionsSrc).not.toContain('targetsMembershipPlan(promo.applies_to) && renderTimeline');
  });

  it('reports the target in the Details modal too', () => {
    expect(detailSrc).toContain("t('detail_applies_to')");
    expect(detailSrc).toContain('promotionTargetOrDefault(detail.applies_to)');
  });
});

describe('locales', () => {
  it('names the section, both options and the Details row in every locale', () => {
    for (const code of LOCALE_CODES) {
      const messages = JSON.parse(readFileSync(join(LOCALES_DIR, `${code}.json`), 'utf-8'));
      const promotions = messages.promotions ?? {};
      for (const key of ['section_applies_to', 'detail_applies_to', ...PROMOTION_TARGET_OPTIONS.map((o) => o.labelKey)]) {
        expect(promotions[key], `${code}: promotions.${key}`).toBeTruthy();
      }
    }
  });
});
