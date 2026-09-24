import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// #635 stage 7 — the Assigned Plan's Promotions section.
//
// The issue thread asks for one expandable card per applied Promotion, showing
// created at / created by / status, with the Promotion's own parameters inside
// it, and a checkbox that takes a standing Promotion off the assignment. §16:
// what the card shows is the *application's* snapshot, so a Promotion edited or
// deleted afterwards cannot move it — which is why the granted lines render
// their own frozen price.
//
// This repo has no component-test infra for apps/admin (see docs/architecture.md's
// TL;DR), so — like assigned-plan-configuration.test.ts (stage 6) — the
// structure is pinned by scanning the component source and the locale files.

const LOCALES_DIR = join(__dirname, '..', '..', 'locales', 'base');
const ASSIGNED_PLANS_DIR = join(__dirname, '..', 'app', '[locale]', 'financials', 'assigned-plans');
const PROMOTIONS = join(ASSIGNED_PLANS_DIR, 'AssignedPlanPromotions.tsx');
const EXPANDED_ROW = join(ASSIGNED_PLANS_DIR, 'AssignedPlanExpandedRow.tsx');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;

type Messages = Record<string, unknown>;

function loadLocale(code: string): Messages {
  return JSON.parse(readFileSync(join(LOCALES_DIR, `${code}.json`), 'utf-8'));
}

function namespaceKeys(messages: Messages): Set<string> {
  const ns = messages.assigned_plans_page;
  if (ns == null || typeof ns !== 'object') return new Set();
  return new Set(Object.keys(ns as Record<string, unknown>));
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const src = stripComments(readFileSync(PROMOTIONS, 'utf-8'));
const rowSrc = stripComments(readFileSync(EXPANDED_ROW, 'utf-8'));
const locales = Object.fromEntries(LOCALE_CODES.map((c) => [c, loadLocale(c)])) as Record<
  (typeof LOCALE_CODES)[number],
  Messages
>;

describe('Assigned Plan promotions: the card header', () => {
  it('is rendered by the expanded row from the assignment detail', () => {
    expect(rowSrc).toContain('<AssignedPlanPromotions');
    expect(rowSrc).toContain('promotions={detail.promotions}');
    // The old flat list is gone: no hand-rolled applied/revoked label.
    expect(rowSrc).not.toContain("promo_applied");
  });

  it('shows created at, created by and the status badge', () => {
    expect(src).toContain('promo_created_at');
    expect(src).toContain('promo_created_by');
    expect(src).toContain('applied_by_name');
    expect(src).toContain('<StatusBadge');
    expect(src, 'the badge must render the status the API computed').toContain('p.display_status');
  });

  it('takes the status from the API rather than deriving one here', () => {
    // CLAUDE.md: no business logic in the frontend. `display_status` is
    // decided by promotionApplicationStatus() server-side.
    expect(src).not.toMatch(/new Date\([^)]*ends_at/);
    expect(src).not.toContain("=== 'revoked'");
  });
});

describe('Assigned Plan promotions: expanding a card', () => {
  it('expands a standing application and refuses an inactive one', () => {
    expect(src).toMatch(/const standing = p\.display_status !== 'inactive'/);
    expect(src).toMatch(/disabled=\{!standing\}/);
    expect(src).toContain('aria-expanded');
  });

  it('shows the Promotion configuration the application froze', () => {
    expect(src).toContain('section_billing_duration');
    // The three durations are rendered from DURATION_FIELDS through
    // `label_${field}`, exactly as the Plan's own section does.
    for (const field of ['free_months', 'paid_months', 'bonus_months']) {
      expect(src, `${field} missing from DURATION_FIELDS`).toMatch(
        new RegExp(`DURATION_FIELDS[\\s\\S]{0,120}'${field}'`),
      );
    }
    expect(src).toContain('label_${field}');
    expect(src).toContain('promo_membership_fee_benefit');
    for (const grants of ['oneoff_grants', 'session_grants', 'periodical_grants']) {
      expect(src, `${grants} missing from the card`).toContain(grants);
    }
  });

  it('prices each granted line from the snapshot, not the catalogue (§17)', () => {
    expect(src).toContain('col_snapshot_price');
    expect(src).toContain('r.unit_price');
    expect(src, 'the card re-reads the live catalogue').not.toContain('/sellable-items');
    expect(src, 'the card re-reads the live Promotion').not.toContain("apiFetch('/promotions");
  });

  it('introduces no modal (§10)', () => {
    expect(src).not.toContain('CrudModal');
    expect(src, 'ConfirmDialog is the shared confirmation, not a CRUD modal')
      .not.toMatch(/Modal(?!$)/m);
  });
});

describe('Assigned Plan promotions: revoking', () => {
  it('clears the checkbox through the revoke endpoint of this assignment', () => {
    expect(src).toContain('/user-memberships/${assignedPlanId}/promotions/${promotion.promotion_id}');
    expect(src).toContain("method: 'DELETE'");
    expect(src, 'revoking must not edit the Promotion itself').not.toContain('/promotions/${promotion.promotion_id}/');
  });

  it('confirms first and disables the control for a read-only role', () => {
    expect(src).toContain('<ConfirmDialog');
    expect(src).toContain('promo_confirm_revoke');
    expect(src).toMatch(/disabled=\{!canWrite \|\| \(!standing && !p\.can_reapply\)\}/);
  });

  it('re-reads the card after a revoke so the Billing Events move with it', () => {
    expect(src).toContain('onChanged()');
    expect(rowSrc).toContain('onChanged={() => { loadDetail(); onChanged(); }}');
  });
});

describe('Assigned Plan promotions: selecting a spent one again (#635 stage 9)', () => {
  it('ticks a spent card back through the apply endpoint of this assignment', () => {
    expect(src).toContain("await apiFetch(`/user-memberships/${assignedPlanId}/promotions`");
    expect(src).toContain("promotion_id: promotion.promotion_id");
    expect(src, 'a re-apply must not edit the Promotion itself')
      .not.toContain("method: 'PUT'");
  });

  it('decides whether the control is offered from the server\'s can_reapply', () => {
    // CLAUDE.md: no business logic in the frontend. Whether a spent
    // application may be agreed again is canReapplyPromotion()'s answer.
    expect(src).toContain('p.can_reapply');
    expect(src).toMatch(/onChange=\{\(\) => \(standing \? setRevoking\(p\) : setReapplying\(p\)\)\}/);
    expect(src, 'the component must not re-derive eligibility')
      .not.toContain('lifecycle_status');
  });

  it('confirms the re-apply separately, saying what is being agreed', () => {
    expect(src).toContain('promo_confirm_reapply');
    expect(src).toContain('promo_reapply_confirm');
    expect(src).toContain('promo_reapply_unavailable');
  });

  it('re-reads the card afterwards, so the price and the events move with it', () => {
    expect(src).toMatch(/reapply[\s\S]{0,400}onChanged\(\)/);
  });
});

describe('Assigned Plan promotions: locales', () => {
  const REQUIRED_KEYS = [
    'promo_created_at', 'promo_created_by', 'promo_toggle_label',
    'promo_revoke_hint', 'promo_reapply_hint', 'promo_reapply_unavailable',
    'promo_confirm_reapply', 'promo_reapply_confirm',
    'promo_confirm_revoke', 'promo_revoke_confirm', 'promo_revoke_dismiss',
    'promo_revoked_at', 'promo_membership_fee_benefit', 'promo_no_membership_fee_benefit',
    'promo_action', 'promo_value', 'promo_duration', 'promo_duration_unbounded',
    'promo_action_no_benefit', 'promo_action_waive', 'promo_action_percentage_discount',
    'promo_action_fixed_discount', 'promo_action_fixed_price',
  ];

  it('has every new key in every locale (next-intl has no fallback)', () => {
    for (const code of LOCALE_CODES) {
      const keys = namespaceKeys(locales[code]);
      const missing = REQUIRED_KEYS.filter((k) => !keys.has(k));
      expect(missing, `${code}.json is missing assigned_plans_page keys`).toEqual([]);
    }
  });

  it('drops the flat applied/revoked labels the StatusBadge replaced', () => {
    for (const code of LOCALE_CODES) {
      const keys = namespaceKeys(locales[code]);
      expect(keys.has('promo_applied'), `${code}.json still carries promo_applied`).toBe(false);
      expect(keys.has('promo_revoked'), `${code}.json still carries promo_revoked`).toBe(false);
      // #635 stage 9: revoking is no longer permanent, so the copy that said
      // so is gone rather than left to be shown by mistake.
      expect(
        keys.has('promo_revoked_permanent'),
        `${code}.json still carries promo_revoked_permanent`,
      ).toBe(false);
    }
  });

  it('labels every status the API can return', () => {
    for (const code of LOCALE_CODES) {
      const status = (locales[code].status ?? {}) as Record<string, unknown>;
      for (const value of ['active', 'inactive', 'expired']) {
        expect(status[value], `${code}.json has no status label for "${value}"`).toBeTruthy();
      }
    }
  });
});
