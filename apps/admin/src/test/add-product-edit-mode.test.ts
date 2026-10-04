import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { primaryBtnSmall } from '@/components/ui';

// #957 — "Add Product" is edit-only and theme-styled.
//
// Three things the ticket settles, and one it deliberately does not:
//   - the copy is the final **Product** terminology (§1 + the implementation
//     note: no intermediate "Add Service" state, since the Service → Product
//     rename #949 has not run yet). Only the locale *values* move — the
//     `services_*` keys are identifiers and renaming those is #949's stage 2;
//   - the action is **absent** in the Member's read-only view and present in
//     Edit mode (§2, and #797's "expanding reads, `⋮ → Edit` writes"), never
//     rendered disabled;
//   - it is a real button wearing the Theme's Buttons group through the
//     existing `primaryBtnSmall()` helper (§3/§4, #912/#954) — no new style and
//     no hardcoded lilac;
//   - the Assigned Plans card has no edit mode, so it keeps the action it
//     always had (§"Preserve": nothing else about the section changes).
//
// apps/admin has no component-test infra (docs/architecture.md's TL;DR), so —
// like additional-periodic-services.test.ts (#631) and
// theme-primary-buttons.test.ts (#954) — this pins the wiring down by scanning
// the sources and the locale files.

const SRC = join(__dirname, '..');
const LOCALES_DIR = join(SRC, '..', 'locales', 'base');
const ASSIGNED_PLANS_DIR = join(SRC, 'components', 'assignedPlan');
const MEMBERS_DIR = join(SRC, 'app', '[locale]', 'members');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;

// The comments in these files name both the old wording and the old lilac to
// explain what moved, so every scan runs on comment-free code.
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const read = (path: string) => stripComments(readFileSync(path, 'utf-8'));

const editorSrc = read(join(ASSIGNED_PLANS_DIR, 'AdditionalPeriodicServices.tsx'));
const assignedPlanRowSrc = read(join(ASSIGNED_PLANS_DIR, 'AssignedPlanExpandedRow.tsx'));
const memberSectionSrc = read(join(MEMBERS_DIR, 'MemberAdditionalServices.tsx'));
const memberRowSrc = read(join(MEMBERS_DIR, 'MemberExpandedRow.tsx'));

const messages = Object.fromEntries(
  LOCALE_CODES.map((code) => [code, JSON.parse(readFileSync(join(LOCALES_DIR, `${code}.json`), 'utf-8'))]),
);

/** Every string the two surfaces of this section show, by namespace. */
const SECTION_STRINGS: Array<[string, string]> = [
  ['members', 'section_additional_services'],
  ['members', 'additional_services_needs_plan'],
  ['assigned_plans_page', 'section_additional_services'],
  ['assigned_plans_page', 'services_none'],
  ['assigned_plans_page', 'services_add'],
  ['assigned_plans_page', 'services_select_item'],
  ['assigned_plans_page', 'services_items_error'],
];

/** "service" in each locale's own language, so a stale value cannot hide in es/ca. */
const SERVICE_WORDS = /servic|servei/i;
const PRODUCT_WORDS = /product/i;

describe('Add Product is only available in Edit mode (#957 §2)', () => {
  it('renders the add action only when the surface asks for it', () => {
    expect(editorSrc).toContain('canAdd');
    // #924 stage 5 added the card-level `editing` gate beside it: the add
    // action needs both, and `canAdd` is still what this ticket decides.
    expect(editorSrc).toContain('{!adding && canAttach && editing && canAdd && (');
  });

  it('defaults canAdd to true, so a surface with no edit mode keeps the action', () => {
    expect(editorSrc).toMatch(/canWrite,\s*canAdd = true/);
    // The Assigned Plans card is that surface: it passes no flag, by design.
    expect(assignedPlanRowSrc).toContain('<AdditionalPeriodicServices');
    expect(assignedPlanRowSrc).not.toContain('canAdd=');
  });

  it('is absent in the Member read-only view rather than disabled', () => {
    // The Member card's Edit-mode flag reaches the editor unchanged, and the
    // gate is on rendering the <button>, not on its `disabled` attribute.
    expect(memberRowSrc).toContain('editing={editing}');
    expect(memberSectionSrc).toContain('canAdd={editing}');
    expect(memberSectionSrc).toContain('editing: boolean');
    expect(editorSrc).not.toMatch(/disabled=\{!canAdd/);
  });

  it('keeps the rest of the section readable in both modes', () => {
    // §"Preserve": only the add action is Edit mode's. The table, the removal
    // action and the needs-a-plan line are untouched, and nothing about the
    // section is gated on `editing` beyond the one prop.
    expect(memberSectionSrc).toContain("t('additional_services_needs_plan')");
    expect(editorSrc).toContain("t('services_remove')");
    expect((memberSectionSrc.match(/editing/g) ?? []).length).toBeLessThanOrEqual(3);
  });
});

describe('Add Product is a themed button (#957 §3, §4)', () => {
  it('wears the shared primary-action helper, not a style of its own', () => {
    expect(editorSrc).toContain('primaryBtnSmall()');
    expect(editorSrc).toMatch(
      /import \{[^}]*\bprimaryBtnSmall\b[^}]*\} from '@\/components\/ui'/,
    );
    // The action it replaced was the lilac text link `linkBtn`, which the
    // section still uses for Remove / Cancel / the draft row's Add.
    expect(editorSrc).not.toMatch(/style=\{\{ \.\.\.linkBtn, marginTop: 8/);
  });

  it('takes its colours from the Theme rather than a literal', () => {
    // #912: the two `var()`s are the Buttons group, read only in ui.tsx.
    expect(primaryBtnSmall().background).toBe('var(--gd-primary-btn, #6c63ff)');
    expect(primaryBtnSmall().color).toBe('var(--gd-primary-btn-text, #ffffff)');
    expect(editorSrc).not.toContain('--gd-primary-btn');
    expect(editorSrc).not.toContain("btnSmall('#6c63ff')");
    expect(editorSrc).not.toContain("background: '#6c63ff'");
  });

  it('keeps the read-only affordance the action already had', () => {
    // #613: a role without write access still sees it dimmed and titled, which
    // is a different question from Edit mode.
    expect(editorSrc).toContain('readOnlyStyle({ ...primaryBtnSmall(), marginTop: 8 }, !canWrite)');
    expect(editorSrc).toContain('const write = canWrite ? {} : { disabled: true, title: readOnlyTitle };');
  });
});

describe('The section speaks Product, not Service (#957 §1)', () => {
  it('says Product in every locale, for every string the section renders', () => {
    for (const code of LOCALE_CODES) {
      for (const [namespace, key] of SECTION_STRINGS) {
        const value = messages[code][namespace]?.[key];
        expect(value, `${code}.json is missing ${namespace}.${key}`).toBeTruthy();
        expect(value, `${code}.json ${namespace}.${key} still says "service"`).not.toMatch(SERVICE_WORDS);
        expect(value, `${code}.json ${namespace}.${key} does not say "product"`).toMatch(PRODUCT_WORDS);
      }
    }
  });

  it('keeps the keys as they are, so #949 stage 2 owns the identifier rename', () => {
    // A key renamed here would have to be renamed again by #949 and would
    // break every other caller in the meantime; the ticket asks for the final
    // *UI* terminology, which is the value.
    expect(editorSrc).toContain("t('services_add')");
    expect(memberRowSrc).toContain("t('members.section_additional_services')");
  });

  it('leaves Professional Services alone', () => {
    // A Professional Service is a different concept that merely shares the
    // word — renaming its copy here would mislabel the Personal Training
    // section on the same card.
    for (const code of LOCALE_CODES) {
      expect(messages[code].members?.pt_slots_no_services).toMatch(/profes/i);
    }
  });
});
