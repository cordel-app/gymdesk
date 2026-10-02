import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import {
  ASSIGNED_PLAN_CONFIGURATION_SECTIONS,
  ASSIGNED_PLAN_SECTION_ORDER,
} from '../app/[locale]/financials/assigned-plans/assignedPlanProfile';
import {
  cardDetailLabelStyle,
  cardDetailRowStyle,
  cardSectionDividedStyle,
  cardSectionLabelStyle,
  cardSectionStyle,
} from '../components/formChrome';

// Regression tests for #924 stage 5 — the Assigned Plan card's own chrome,
// section order and read-only/Edit split.
//
// §1: "Do not create a separate visual system for Assigned Plans." Stages 1–4
// brought the benefit grids, the Example Timeline and the Billing Event
// Simulation onto the shared components; what was left was the card itself —
// four files with their own section header, their own `Label: Value` row at a
// different label width from the Membership Plan card's, a `#111` Save button no
// Theme could reach, a lilac text link for the section `Edit` action, and every
// write control reachable straight from the read-only card, which #797/#897
// forbid.
//
// This repo has no component-test infra for apps/admin (see docs/architecture.md's
// TL;DR), so — like member-card-chrome.test.ts (#929) — the shared styles are
// asserted directly and the wiring is pinned by scanning the sources.

const SRC = join(__dirname, '..');
const LOCALES_DIR = join(SRC, '..', 'locales', 'base');
const ASSIGNED_PLANS_DIR = join(SRC, 'app', '[locale]', 'financials', 'assigned-plans');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function read(file: string): string {
  return stripComments(readFileSync(join(ASSIGNED_PLANS_DIR, file), 'utf-8'));
}

/** Every file the Assigned Plan card is built from. */
const CARD_FILES = [
  'AssignedPlanExpandedRow.tsx',
  'AssignedPlanConfiguration.tsx',
  'AssignedPlanPromotions.tsx',
  'AdditionalPeriodicServices.tsx',
] as const;

const sources = new Map(CARD_FILES.map((f) => [f, read(f)] as const));
const rowSrc = sources.get('AssignedPlanExpandedRow.tsx')!;
const configSrc = sources.get('AssignedPlanConfiguration.tsx')!;
const promotionsSrc = sources.get('AssignedPlanPromotions.tsx')!;
const servicesSrc = sources.get('AdditionalPeriodicServices.tsx')!;

function namespace(code: string): Record<string, string> {
  const messages = JSON.parse(readFileSync(join(LOCALES_DIR, `${code}.json`), 'utf-8'));
  return (messages.assigned_plans_page ?? {}) as Record<string, string>;
}

describe('#924 stage 5: the section order is a declaration, not the JSX', () => {
  it('covers every file the card is built from', () => {
    // A section file added later must be listed above, or it can quietly grow
    // another copy of the chrome and never be noticed.
    const present = readdirSync(ASSIGNED_PLANS_DIR).filter((f) => f.endsWith('.tsx'));
    const unlisted = present.filter(
      (f) => f !== 'page.tsx' && !f.endsWith('Modal.tsx') && !CARD_FILES.includes(f as any),
    );
    expect(unlisted, 'Assigned Plan card file not covered by this test').toEqual([]);
  });

  it('lists the Membership Plan card\'s order plus the three things only an assignment has', () => {
    expect([...ASSIGNED_PLAN_SECTION_ORDER]).toEqual([
      'section_members',
      'section_pricing',
      'section_billing_duration',
      'section_membership_fee_benefit',
      'benefits_oneoff',
      'benefits_session',
      'benefits_period',
      'section_promotions',
      'section_fee_simulation',
      'section_billing_forecast',
      'section_additional_services',
      'section_billing_events',
    ]);
  });

  it('keeps the two simulations adjacent, fee first (neither grows into the other)', () => {
    const fee = ASSIGNED_PLAN_SECTION_ORDER.indexOf('section_fee_simulation');
    const forecast = ASSIGNED_PLAN_SECTION_ORDER.indexOf('section_billing_forecast');
    expect(forecast).toBe(fee + 1);
  });

  it('keeps Additional Products below both simulations and the ledger last (§11, Q4)', () => {
    const forecast = ASSIGNED_PLAN_SECTION_ORDER.indexOf('section_billing_forecast');
    const additional = ASSIGNED_PLAN_SECTION_ORDER.indexOf('section_additional_services');
    expect(additional).toBe(forecast + 1);
    expect(ASSIGNED_PLAN_SECTION_ORDER.indexOf('section_billing_events'))
      .toBe(ASSIGNED_PLAN_SECTION_ORDER.length - 1);
  });

  it('gives AssignedPlanConfiguration a contiguous slice of that order', () => {
    // Contiguity is what makes the flat order true of the rendered card: the
    // five snapshot sections are rendered by one component, between PRICING and
    // the applied Promotions.
    const first = ASSIGNED_PLAN_SECTION_ORDER.indexOf(ASSIGNED_PLAN_CONFIGURATION_SECTIONS[0]);
    expect(first).toBeGreaterThan(-1);
    expect(
      ASSIGNED_PLAN_SECTION_ORDER.slice(first, first + ASSIGNED_PLAN_CONFIGURATION_SECTIONS.length),
    ).toEqual([...ASSIGNED_PLAN_CONFIGURATION_SECTIONS]);
  });

  it('renders the row\'s own sections in the declared order', () => {
    const owned = ASSIGNED_PLAN_SECTION_ORDER.filter(
      (key) => !ASSIGNED_PLAN_CONFIGURATION_SECTIONS.includes(key as never),
    );
    const positions = owned.map((key) => {
      const at = rowSrc.indexOf(`t('${key}')`);
      expect(at, `the expanded row does not render ${key}`).toBeGreaterThan(-1);
      return at;
    });
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('mounts the snapshot sections where the declaration puts them', () => {
    const pricing = rowSrc.indexOf("t('section_pricing')");
    const configuration = rowSrc.indexOf('<AssignedPlanConfiguration');
    const promotions = rowSrc.indexOf("t('section_promotions')");
    expect(configuration).toBeGreaterThan(pricing);
    expect(promotions).toBeGreaterThan(configuration);
  });

  it('renders the five snapshot sections in the declared order too', () => {
    // The first two are rendered one by one and the three benefit kinds from
    // `BENEFIT_SECTIONS`, so the rendered order is the two markers followed by
    // that list's own order. Scanned from the component's `return`, since the
    // keys also appear in the declaration above it.
    const jsx = configSrc.slice(configSrc.indexOf('  return ('));
    const markers = [
      "label={t('section_billing_duration')}",
      "label={t('section_membership_fee_benefit')}",
      'BENEFIT_SECTIONS.map(',
    ].map((marker) => {
      const at = jsx.indexOf(marker);
      expect(at, `the configuration does not render ${marker}`).toBeGreaterThan(-1);
      return at;
    });
    expect(markers).toEqual([...markers].sort((a, b) => a - b));

    const rendered = [...configSrc.matchAll(/titleKey: '(benefits_\w+)'/g)].map((m) => m[1]);
    expect(rendered).toEqual(
      ASSIGNED_PLAN_CONFIGURATION_SECTIONS.filter((key) => key.startsWith('benefits_')),
    );
  });

  it('drops the nested heading the Plan card has no counterpart for', () => {
    // The five sections above used to sit under one `MEMBERSHIP PLAN
    // CONFIGURATION` label, a level of structure §1 forbids.
    expect(rowSrc).not.toContain('section_configuration');
    for (const code of LOCALE_CODES) {
      expect(
        namespace(code).section_configuration,
        `${code}.json still carries assigned_plans_page.section_configuration`,
      ).toBeUndefined();
    }
  });
});

describe('#924 stage 5: one declaration of the chrome (#929)', () => {
  it('renders every section through the shared CardSection', () => {
    for (const file of ['AssignedPlanExpandedRow.tsx', 'AssignedPlanConfiguration.tsx'] as const) {
      const src = sources.get(file)!;
      expect(src, `${file} does not import CardSection`)
        .toContain("import { CardSection } from '@/components/CardSection'");
      expect(src).toContain('<CardSection');
    }
  });

  it('declares no section header, field pair, control box or card border of its own', () => {
    for (const [file, src] of sources) {
      // The section header's own numbers (`cardSectionLabelStyle`).
      expect(src, `${file} restates the section header`).not.toMatch(/fontSize: 11,\s*fontWeight: 700/);
      // The 140px `Label: Value` row the card had three copies of.
      expect(src, `${file} restates the detail row`).not.toContain('minWidth: 140');
      // The control box's own border (`formControlStyle`).
      expect(src, `${file} restates the input border`).not.toContain("border: '1px solid #d1d5db'");
      // And a card's own border (`innerCardStyle` / `cardSurfaceStyle`).
      expect(src, `${file} restates the card border`).not.toContain("border: '1px solid #e8e8ed'");
      // A section header or a label/value pair of its own.
      for (const local of ['function Section(', 'function SectionHeader(', 'function Field(', 'function DetailRow(']) {
        expect(src, `${file} declares its own ${local}`).not.toContain(local);
      }
    }
  });

  it('takes a primary action from the Theme rather than a colour of its own', () => {
    for (const [file, src] of sources) {
      expect(src, `${file} hardcodes a button colour`).not.toContain("'#6c63ff'");
      expect(src, `${file} hardcodes a button colour`).not.toContain("'#111'");
    }
    // The section editors' Save, and the inline Add of a product.
    expect(configSrc).toContain('primaryBtnSmall()');
    expect(servicesSrc).toContain('primaryBtnSmall()');
    for (const src of [configSrc, servicesSrc]) {
      expect(src).toMatch(/import \{[^}]*\bprimaryBtnSmall\b[^}]*\} from '@\/components\/ui'/);
      expect(src).toContain('secondaryBtnSmall');
    }
  });

  it('separates each section from the one above it, and the first from nothing', () => {
    // #929 §4: the hairline is the card's own themed border, and it belongs to
    // every section but the first — which is the one the row marks.
    expect(cardSectionStyle.borderTop).toBeUndefined();
    expect(cardSectionDividedStyle.borderTop).toBe('1px solid var(--gd-card-border, #e8e8ed)');
    expect(rowSrc).toContain("label={t('section_members')} first");
    expect((rowSrc.match(/\bfirst\b/g) ?? []).length).toBe(1);
  });

  it('lines the card\'s values up with the Membership Plan card\'s', () => {
    // The Plan card's own numbers (#547): a 200px label beside a 13.5px value.
    expect(cardDetailLabelStyle.width).toBe(200);
    expect(cardDetailRowStyle.fontSize).toBe(13.5);
  });

  it('keeps the shared pieces presentational — no endpoint, no permission, no key', () => {
    for (const file of ['CardSection.tsx', 'CardDetailRow.tsx'] as const) {
      const src = stripComments(readFileSync(join(SRC, 'components', file), 'utf-8'));
      expect(src, `${file} resolves a locale key`).not.toContain('useTranslations');
      expect(src, `${file} names an endpoint`).not.toContain('apiFetch');
      expect(src, `${file} decides a permission`).not.toContain('canWrite');
    }
    // The section label itself still comes from the page's own namespace.
    expect(cardSectionLabelStyle.textTransform).toBe('uppercase');
  });
});

describe('#924 stage 5: expanding reads, ⋮ → Edit writes (#797/#897)', () => {
  it('makes the context menu the single entry point into Edit mode, and out of it', () => {
    expect(rowSrc).toContain('const [isEditing, setIsEditing] = useState(false)');
    expect(rowSrc).toMatch(/label: isEditing \? t\('action_done_editing'\) : t\('action_edit'\)/);
    expect(rowSrc).toContain('onClick: () => setIsEditing(!isEditing)');
    // A terminal assignment has nothing to edit, so the action is not offered.
    expect(rowSrc).toContain('const canEnterEdit = EDITABLE_STATUSES.includes(detail.status)');
  });

  it('hands the card\'s flag to every section that can write', () => {
    expect(rowSrc).toContain('cardEditing={isEditing}');
    expect((rowSrc.match(/cardEditing=\{isEditing\}/g) ?? []).length).toBe(2);
    expect(rowSrc).toContain('editing={isEditing}');
  });

  it('has no section Edit button outside Edit mode — absent, not disabled', () => {
    expect(configSrc).toContain('const editable = cardEditing && canWrite && EDITABLE_STATUSES.includes(planStatus)');
    expect(configSrc).toMatch(/function editButton[\s\S]{0,120}if \(!editable\) return null/);
    // And inside it, the one shared subsection action (#901).
    expect(configSrc).toContain("import { SectionEditButton } from '@/components/SectionEditButton'");
    expect(configSrc).toContain('<SectionEditButton');
    expect(configSrc, 'the section Edit action is styled by the page again').not.toContain('linkBtn');
  });

  it('renders no write control on the read-only card', () => {
    // The applied Promotions' revoke/re-apply checkbox…
    expect(promotionsSrc).toMatch(/\{cardEditing && \(\s*<input/);
    // …the Remove of an attached product, and its `+ Add`.
    expect(servicesSrc).toMatch(/editing \? \(\s*<button/);
    expect(servicesSrc).toContain('{!adding && canAttach && editing && (');
  });

  it('closes every section editor when the mode is left (#897)', () => {
    expect(configSrc).toMatch(/if \(!cardEditing\) cancelEdit\(\)/);
    expect(servicesSrc).toMatch(/if \(!editing\) \{\s*setAdding\(false\)/);
  });

  it('leaves the Member page\'s own services section editable in place', () => {
    // `AdditionalPeriodicServices` is shared with the Member card, whose
    // ADDITIONAL SERVICES section is not behind an Edit mode — so the flag
    // defaults to true and that page passes nothing.
    expect(servicesSrc).toContain('editing = true');
    const memberSection = stripComments(
      readFileSync(join(SRC, 'app', '[locale]', 'members', 'MemberAdditionalServices.tsx'), 'utf-8'),
    );
    expect(memberSection).not.toContain('editing=');
  });
});

describe('#924 §11: Additional Periodic Services is renamed Additional Products', () => {
  const EXPECTED: Record<(typeof LOCALE_CODES)[number], string> = {
    en: 'Additional Products',
    es: 'Productos Adicionales',
    ca: 'Productes Addicionals',
  };

  it.each(LOCALE_CODES)('reads "Additional Products" in %s.json', (code) => {
    expect(namespace(code).section_additional_services).toBe(EXPECTED[code]);
  });

  it('keeps the section, its endpoints and its rules (§11)', () => {
    expect(rowSrc).toContain("t('section_additional_services')");
    expect(rowSrc).toContain('<AdditionalPeriodicServices');
    expect(servicesSrc).toContain('/user-memberships/${assignedPlanId}/services');
    expect(servicesSrc).toContain('ATTACHABLE_STATUSES');
  });

  it('labels Edit mode in every locale, with the namespace still in parity', () => {
    const enKeys = new Set(Object.keys(namespace('en')));
    for (const code of LOCALE_CODES) {
      const keys = new Set(Object.keys(namespace(code)));
      expect(keys.has('action_done_editing'), `${code}.json is missing action_done_editing`).toBe(true);
      expect(keys.has('action_edit'), `${code}.json is missing action_edit`).toBe(true);
      if (code === 'en') continue;
      expect([...enKeys].filter((k) => !keys.has(k)), `${code}.json is missing keys`).toEqual([]);
      expect([...keys].filter((k) => !enKeys.has(k)), `${code}.json has stray keys`).toEqual([]);
    }
  });
});
