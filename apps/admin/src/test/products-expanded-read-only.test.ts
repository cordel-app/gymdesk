import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  EMPTY_VALUE,
  PRODUCT_ENROLLMENT_STATUSES,
  PRODUCT_SECTIONS,
  PRODUCT_SECTION_ORDER,
  PRODUCT_STATUSES,
  PRODUCT_TYPES,
  toProductFormValues,
  visibleProductSections,
} from '@/app/[locale]/financials/products/productProfile';
import {
  fullWidthCellStyle,
  productCheckboxCellStyle,
  productGridStyle,
  productTextareaStyle,
  productValueStyle,
} from '@/app/[locale]/financials/products/ProductLayout';
import {
  cardSectionDividedStyle,
  cardSectionStyle,
  formControlStyle,
  formValueStyle,
  inlineActionsRowStyle,
  secondaryBtnSmall,
} from '@/components/formChrome';
import { cardSectionHeaderStyle } from '@/components/CardSectionHeader';

// #974 — a Product's expanded card reads in the Edit form's own shape.
//
//   Collapsed      → the summary row
//   Expanded       → the same sections, the same fields, read-only
//   ⋮ → Edit       → the same sections, the same fields, editable
//
// Before this ticket the two halves agreed on the five section names and on
// nothing else: the read-only view was a 160px-label `Label: value` list that
// omitted Name and joined the Professional Services into a sentence, while the
// editor was a two-column grid. Every field added since had to be added twice,
// in two shapes — which is what `productProfile.ts` +
// `ProductLayout.tsx` remove.
//
// apps/admin has no component-test infra (docs/architecture.md's TL;DR), so the
// pure declaration is exercised directly and the page's wiring is pinned by
// scanning its source, as plans-expanded-read-only.test.ts does.

const ITEM_DIR = join(__dirname, '..', 'app', '[locale]', 'financials', 'products');
const LOCALES_DIR = join(__dirname, '..', '..', 'locales', 'base');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const pageSrc = stripComments(readFileSync(join(ITEM_DIR, 'page.tsx'), 'utf-8'));
const layoutSrc = stripComments(readFileSync(join(ITEM_DIR, 'ProductLayout.tsx'), 'utf-8'));
const profileSrc = stripComments(readFileSync(join(ITEM_DIR, 'productProfile.ts'), 'utf-8'));

/**
 * The expanded card alone — from the body both modes render to the end of
 * `renderRow`. The Details modal further down the page keeps its own field
 * list and its own grid, which #974 §7 leaves exactly where they are.
 */
const cardBodySrc = (() => {
  const start = pageSrc.indexOf('{(isExpanded || isEditing) && (');
  const end = pageSrc.indexOf('if (gymLoading || !canRead) return null;', start);
  if (start < 0 || end <= start) throw new Error('expanded card body not found');
  return pageSrc.slice(start, end);
})();

function namespace(code: string): Record<string, unknown> {
  const messages = JSON.parse(readFileSync(join(LOCALES_DIR, `${code}.json`), 'utf-8'));
  return (messages.products ?? {}) as Record<string, unknown>;
}

const locales = Object.fromEntries(LOCALE_CODES.map((c) => [c, namespace(c)]));

describe('the field set is declared once (#974 §1)', () => {
  it('keeps the Edit form\'s five sections, in the Edit form\'s order', () => {
    expect(PRODUCT_SECTION_ORDER).toEqual([
      'general', 'billing', 'professional_services', 'package_info', 'notes',
    ]);
  });

  it('declares every field exactly once across the sections', () => {
    const keys = PRODUCT_SECTIONS.flatMap((s) => s.fields.map((f) => f.key));
    expect(new Set(keys).size).toBe(keys.length);
    // The whole of what `PUT /sellable-items/:id` carries, plus the Name the
    // read-only half used to omit.
    expect(keys).toEqual([
      'name', 'type', 'description', 'units', 'status', 'enrollment_status', 'mandatory',
      'amount', 'billing_frequency', 'validity_days', 'tax_rate_id',
      'professional_services', 'package_information', 'notes',
    ]);
  });

  it('translates every section title and every field label in en/es/ca', () => {
    for (const code of LOCALE_CODES) {
      for (const section of PRODUCT_SECTIONS) {
        expect(locales[code][section.titleKey], `${code}.json: ${section.titleKey}`).toBeTypeOf('string');
        for (const field of section.fields) {
          if (!field.labelKey) continue;
          expect(locales[code][field.labelKey], `${code}.json: ${field.labelKey}`).toBeTypeOf('string');
        }
      }
    }
  });

  it('labels only the fields a section header does not already name', () => {
    // A lone Notes textarea under a NOTES heading needs no second label, and
    // neither do the Professional Services chips or the Package information.
    const unlabelled = PRODUCT_SECTIONS
      .flatMap((s) => s.fields)
      .filter((f) => !f.labelKey)
      .map((f) => f.key);
    expect(unlabelled).toEqual(['professional_services', 'package_information', 'notes']);
  });

  it('spans the grid with free text rather than squeezing it into a cell', () => {
    const fullWidth = PRODUCT_SECTIONS.flatMap((s) => s.fields).filter((f) => f.fullWidth);
    expect(fullWidth.map((f) => f.key)).toEqual([
      'description', 'professional_services', 'package_information', 'notes',
    ]);
  });

  it('holds the option sets the three forms share', () => {
    expect(PRODUCT_TYPES).toEqual(['fee', 'service', 'sessions', 'merchandise', 'other']);
    expect(PRODUCT_STATUSES).toEqual(['active', 'inactive']);
    expect(PRODUCT_ENROLLMENT_STATUSES).toEqual(['public', 'staff_only']);
    // …and the page no longer spells them out beside the declaration.
    expect(pageSrc).not.toMatch(/const TYPES = \[/);
    expect(pageSrc).toContain('const TYPES = PRODUCT_TYPES;');
  });

  it('maps a persisted row onto the form the context menu opens', () => {
    const values = toProductFormValues({
      name: 'Monthly fee', type: 'fee', units: null, description: null, amount: '29.990',
      billing_frequency: 'month', status: 'active', enrollment_status: 'public',
      notes: null, package_information: null, validity_days: null, tax_rate_id: 7,
      mandatory: 1, professional_services: [{ id: 3 }, { id: 4 }],
    });
    expect(values).toEqual({
      name: 'Monthly fee', type: 'fee', units: '', description: '', amount: '29.99',
      billing_frequency: 'month', status: 'active', enrollment_status: 'public',
      notes: '', package_information: '', validity_days: '', tax_rate_id: '7',
      mandatory: true, professionalServiceIds: [3, 4],
    });
  });

  it('turns every null column into an empty control rather than the string "null"', () => {
    const values = toProductFormValues({
      name: 'X', type: 'other', units: null, description: null, amount: null,
      billing_frequency: null, status: 'inactive', enrollment_status: 'staff_only',
      notes: null, package_information: null, validity_days: null, tax_rate_id: null,
      mandatory: 0,
    });
    for (const key of ['units', 'description', 'amount', 'billing_frequency', 'notes',
      'package_information', 'validity_days', 'tax_rate_id'] as const) {
      expect(values[key], key).toBe('');
    }
    expect(values.mandatory).toBe(false);
    expect(values.professionalServiceIds).toEqual([]);
  });
});

describe('both halves see the same sections (#974 §1/§3)', () => {
  const custom = { isSystem: false, isSessionType: false };

  it('hides the Professional Services section for a non-session item', () => {
    expect(visibleProductSections(custom).map((s) => s.key))
      .toEqual(['general', 'billing', 'package_info', 'notes']);
  });

  it('shows it for a session item, in its declared position', () => {
    expect(visibleProductSections({ ...custom, isSessionType: true }).map((s) => s.key))
      .toEqual(['general', 'billing', 'professional_services', 'package_info', 'notes']);
  });

  it('drops Package information and Validity for a System item', () => {
    const sections = visibleProductSections({ isSystem: true, isSessionType: false });
    expect(sections.map((s) => s.key)).toEqual(['general', 'billing', 'notes']);
    const billing = sections.find((s) => s.key === 'billing')!;
    expect(billing.fields.map((f) => f.key)).toEqual(['amount', 'billing_frequency', 'tax_rate_id']);
  });

  it('reports a System row\'s frozen columns as values, not as missing fields', () => {
    // `PUT /sellable-items/:id` writes name/type/units only inside its
    // `is_system` guard, so the form must not offer a control — but the card
    // still has to report them, as it did before #974.
    const general = visibleProductSections({ isSystem: true, isSessionType: false })
      .find((s) => s.key === 'general')!;
    expect(general.fields.map((f) => f.key)).toEqual([
      'name', 'type', 'description', 'units', 'status', 'enrollment_status', 'mandatory',
    ]);
    const frozen = general.fields.filter((f) => !f.editable).map((f) => f.key);
    expect(frozen).toEqual(['name', 'type', 'units']);
  });

  it('leaves a custom item every field editable', () => {
    const sections = visibleProductSections({ isSystem: false, isSessionType: true });
    expect(sections.flatMap((s) => s.fields).every((f) => f.editable)).toBe(true);
  });

  it('keeps a System item\'s Mandatory flag editable (#832)', () => {
    const general = visibleProductSections({ isSystem: true, isSessionType: false })
      .find((s) => s.key === 'general')!;
    expect(general.fields.find((f) => f.key === 'mandatory')!.editable).toBe(true);
  });

  it('never renders a section with no visible field', () => {
    for (const flags of [
      { isSystem: false, isSessionType: false },
      { isSystem: false, isSessionType: true },
      { isSystem: true, isSessionType: false },
      { isSystem: true, isSessionType: true },
    ]) {
      for (const section of visibleProductSections(flags)) {
        expect(section.fields.length, section.key).toBeGreaterThan(0);
      }
    }
  });
});

describe('the layout owns the structure and neither half restates it (#974 §1)', () => {
  it('is rendered by the one expanded body, in both modes', () => {
    expect(pageSrc).toContain('{(isExpanded || isEditing) && (');
    expect(pageSrc).toContain('<ProductLayout');
    expect((pageSrc.match(/<ProductLayout/g) ?? []).length).toBe(1);
    expect(pageSrc).toContain('editing={isEditing}');
  });

  it('no longer carries a second read-only rendering of the card', () => {
    // The two sub-components the two halves used to diverge through.
    expect(pageSrc).not.toContain('function SectionHeader(');
    expect(pageSrc).not.toContain('function DetailRow(');
    expect(pageSrc).not.toMatch(/\{\/\* Read-only expanded \*\/\}/);
  });

  it('asks the declaration which sections to render, off the draft\'s own Type', () => {
    // Choosing Sessions in the editor reveals the Professional Services section
    // before the row is saved, which is what the editor did before #974.
    expect(pageSrc).toContain('const draftType = isEditing && editForm ? editForm.type : item.type;');
    expect(pageSrc).toMatch(/visibleProductSections\(\{\s*isSystem,\s*isSessionType: draftType === SESSION_TYPE,/);
  });

  it('decides per field which callback fills the cell, in one place', () => {
    expect(layoutSrc).toContain('{editing && field.editable ? renderField(field) : renderValue(field)}');
    // One decision: a frozen field is a value in *both* modes.
    expect((layoutSrc.match(/renderField\(field\)/g) ?? []).length).toBe(1);
  });

  it('marks a required field only while it is being edited', () => {
    expect(layoutSrc).toContain("{editing && field.editable && field.required ? ' *' : ''}");
    expect(profileSrc).toContain("key: 'name', labelKey: 'label_name', required: true");
  });

  it('puts a section\'s actions immediately after its title (#963, #974 §4)', () => {
    expect(layoutSrc).toContain('<CardSectionHeader title={sectionTitle(section)}');
    // Never pushed to the far edge, and the shared header makes the reverse
    // order unexpressible.
    expect(layoutSrc).not.toContain('space-between');
    expect(cardSectionHeaderStyle.justifyContent).toBeUndefined();
  });

  it('separates every section but the first with the card\'s own hairline (#929)', () => {
    expect(layoutSrc).toContain('index === 0 ? cardSectionStyle : cardSectionDividedStyle');
    expect(cardSectionStyle.borderTop).toBeUndefined();
    expect(cardSectionDividedStyle.borderTop).toBe('1px solid var(--gd-card-border, #e8e8ed)');
  });

  it('resolves no locale key and names no endpoint', () => {
    // #806's rule: the module's permission gate and its labels stay the page's.
    expect(layoutSrc).not.toContain('useTranslations');
    expect(layoutSrc).not.toContain('apiFetch');
    expect(layoutSrc).not.toContain('/sellable-items');
  });

  it('reflows the same way in both modes instead of a fixed two-column form', () => {
    expect(productGridStyle.gridTemplateColumns).toBe('repeat(auto-fit, minmax(240px, 1fr))');
    expect(fullWidthCellStyle.gridColumn).toBe('1 / -1');
    expect(cardBodySrc).not.toContain("gridTemplateColumns: '1fr 1fr'");
  });

  it('gives the card one body padding, so nothing shifts as Edit opens', () => {
    expect(pageSrc).toContain('const expandedBodyStyle');
    expect((pageSrc.match(/style=\{expandedBodyStyle\}/g) ?? []).length).toBe(1);
    expect(pageSrc).not.toContain("padding: '0 20px 16px'");
  });
});

describe('expanded means read-only (#974 §2)', () => {
  it('renders a value in the box its control occupies (#929)', () => {
    expect(productValueStyle).toBe(formValueStyle);
    expect(productValueStyle.padding).toBe(formControlStyle.padding);
    expect(productValueStyle.border).toBe('1px solid transparent');
  });

  it('puts every control behind the editing flag', () => {
    // Each `<input>`, `<select>` and `<textarea>` of the card lives in
    // `renderEditControl`, which the layout calls only while editing.
    const start = pageSrc.indexOf('function renderEditControl(');
    const end = pageSrc.indexOf('const menuItems: ContextMenuItem[]', start);
    expect(start).toBeGreaterThan(-1);
    const editControls = pageSrc.slice(start, end);
    const readStart = pageSrc.indexOf('function renderReadOnlyValue(');
    const readOnly = pageSrc.slice(readStart, start);
    for (const control of ['<input', '<select', '<textarea', 'onChange']) {
      expect(editControls, control).toContain(control);
      expect(readOnly, control).not.toContain(control);
    }
  });

  it('shows the Professional Services as spans, never as disabled checkboxes (#799)', () => {
    expect(pageSrc).toContain('<span key={ps.id} style={selectedChipStyle}>{ps.name}</span>');
    expect(pageSrc).toContain('const selectedChipStyle: React.CSSProperties = { ...chipCheckboxLabel(true)');
    expect(pageSrc).not.toContain('disabled checkbox');
    // The comma-joined sentence the read-only half used to collapse them into.
    expect(cardBodySrc).not.toContain("professional_services.map((s) => s.name).join(', ')");
  });

  it('keeps the Save/Cancel pair out of the read-only half', () => {
    const save = pageSrc.indexOf('{isEditing && editForm && (');
    expect(save).toBeGreaterThan(pageSrc.indexOf('<ProductLayout'));
    expect(pageSrc).toMatch(/\{isEditing && editForm && \([\s\S]{0,900}handleSave\(item\)/);
  });

  it('reads an unset value as one placeholder, everywhere', () => {
    expect(EMPTY_VALUE).toBe('—');
    expect(pageSrc).toContain('?? EMPTY_VALUE');
  });

  it('leaves the ⋮ menu the single entry point into the form (#797)', () => {
    expect(pageSrc).toContain("{ label: t('edit'), onClick: () => openEdit(item), disabled: !canWrite");
    expect(pageSrc).toContain('setExpanded((prev) => new Set([...prev, item.id]));');
  });
});

describe('the card\'s buttons follow the Theme (#974 §4/§5)', () => {
  it('left-aligns both inline forms\' actions, with no rule above them', () => {
    expect(inlineActionsRowStyle.justifyContent).toBeUndefined();
    expect(inlineActionsRowStyle.borderTop).toBeUndefined();
    // The create card and the inline editor, both on the shared row.
    expect((pageSrc.match(/style=\{inlineActionsRowStyle\}/g) ?? []).length).toBe(2);
    expect(pageSrc).not.toContain("justifyContent: 'flex-end'");
  });

  it('pairs a themed primary Save with the shared neutral Cancel', () => {
    expect((pageSrc.match(/style=\{primaryBtnSmall\(\)\}/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect((pageSrc.match(/style=\{secondaryBtnSmall\}/g) ?? []).length).toBe(2);
    // #912/#954: no colour of its own, on either button.
    expect(pageSrc).not.toContain("btnSmall('#888')");
    expect(pageSrc).not.toContain('#6c63ff');
    expect(secondaryBtnSmall.border).toBe('1px solid var(--gd-input-border, #d1d5db)');
  });

  it('takes its controls from formChrome rather than respelling them (#929)', () => {
    for (const dead of [
      'const inlineInputStyle', 'const inlineSelectStyle', 'const inlineLabelStyle',
      'const checkboxLabelStyle', 'const errorStyle',
    ]) {
      expect(pageSrc, dead).not.toContain(dead);
    }
    expect(pageSrc).not.toContain("border: '1px solid #ccc'");
    expect(formControlStyle.border).toBe('1px solid var(--gd-input-border, #d1d5db)');
    expect(productTextareaStyle.border).toBe(formControlStyle.border);
    expect(productTextareaStyle.resize).toBe('vertical');
  });

  it('keeps a boolean field the same height in both modes', () => {
    expect(productCheckboxCellStyle.padding).toBe(formValueStyle.padding);
    expect(productCheckboxCellStyle.border).toBe(formValueStyle.border);
  });
});

describe('nothing about the item itself changed (#974 §6)', () => {
  it('submits the same PUT payload as before', () => {
    for (const line of [
      "name: editForm.name.trim() || undefined,",
      "mandatory: editForm.mandatory,",
      "professional_service_ids:",
    ]) {
      expect(pageSrc, line).toContain(line);
    }
  });

  it('leaves the Details modal as the home of the audit metadata (#974 §7)', () => {
    expect(pageSrc).toContain("<ModalSection title={t('section_audit')} />");
    expect(pageSrc).toContain('<ViewAuditLogButton entityType="gym_charge"');
    // …and keeps it out of the expanded card, in either mode.
    expect(cardBodySrc).not.toContain("t('audit_created_by')");
    expect(cardBodySrc).not.toContain('ViewAuditLogButton');
  });

  // #949 stage 2 renamed the entity in the code; stage 3 owns the API root, the
  // table and the audit entity type, so those three deliberately still read the
  // old way here and this pins both halves of that line.
  it('says Product everywhere the code decides, and leaves the wire to stage 3 (#949)', () => {
    expect(pageSrc).toContain("useTranslations('products')");
    // The API root and the audit entity type are stage 3's, so the page still
    // calls them by the names they really have. The retired *identifiers* are
    // gated across all three source trees by
    // `api/src/test/product-identifiers.unit.test.ts`.
    expect(pageSrc).toContain("apiFetch<Product>('/sellable-items'");
    expect(pageSrc).toContain('entityType="gym_charge"');
  });
});
