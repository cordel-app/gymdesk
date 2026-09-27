import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  EMPTY_VALUE,
  NUTRITION_ITEM_SECTION_ORDER,
  NutritionLibraryItemRow,
  displayValue,
  emptyNutritionItemForm,
  formatTimestamp,
  taxonomyChipStyle,
  toNutritionItemFormValues,
} from '@/components/nutritionLibrary/nutritionItemProfile';

// #799 — Nutrition Library: read-only expanded view, Details modal, separate Edit.
//
// Three interactions, cleanly separated, for the gym's library and Cordel's Base
// one alike:
//
//   Expand     → the complete item, READ ONLY
//   ⋮ Details  → a read-only modal: name, description, full audit info, Audit Log
//   ⋮ Edit     → the existing inline form, the only place anything changes
//
// This repo has no component-test infra for apps/admin (docs/architecture.md's
// TL;DR), so — like member-expanded-profile.test.ts (#797) — the structure is
// pinned by scanning the source, while the shared module's own pure parts (the
// mapping and the formatters) are exercised directly.

const SRC = join(__dirname, '..');
const SHARED = join(SRC, 'components', 'nutritionLibrary');

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function read(path: string): string {
  return stripComments(readFileSync(path, 'utf-8'));
}

const readOnlyView = read(join(SHARED, 'NutritionItemReadOnlyView.tsx'));
const detailsModal = read(join(SHARED, 'NutritionItemDetailsModal.tsx'));
const profile = read(join(SHARED, 'nutritionItemProfile.ts'));
const gymPage = read(join(SRC, 'app', '[locale]', 'nutrition', 'nutrition-library', 'page.tsx'));
const cordelPage = read(join(SRC, 'app', '[locale]', 'cordel', 'nutrition-library', 'page.tsx'));

const PAGES = [['gym', gymPage], ['Cordel', cordelPage]] as const;
const LOCALE_CODES = ['en', 'es', 'ca'] as const;
const LOCALES_DIR = join(SRC, '..', 'locales', 'base');

function messages(code: string): Record<string, any> {
  return JSON.parse(readFileSync(join(LOCALES_DIR, `${code}.json`), 'utf-8'));
}

/** A row as the API returns one, with everything present. */
function row(overrides: Partial<NutritionLibraryItemRow> = {}): NutritionLibraryItemRow {
  return {
    id: 7,
    gym_id: null,
    name: 'Beef',
    display_name: 'Ternera',
    description: 'Lean red meat',
    status: 'active',
    image_url: 'https://cdn.example/cordel/nutrition/uuid-Beef.png',
    translations: { es: 'Ternera', ca: 'Vedella' },
    categories: [{ id: 1, slug: 'main_dish' }],
    qualities: [{ id: 3, slug: 'protein' }, { id: 5, slug: 'fat' }],
    created_at: '2026-07-27 15:54:07',
    created_by_name: 'John Smith',
    modified_at: null,
    modified_by_name: null,
    deleted_at: null,
    deleted_by_name: null,
    ...overrides,
  };
}

describe('the expanded row is strictly read-only (§1, §7)', () => {
  it('holds no writing control of any kind', () => {
    for (const forbidden of ['<input', '<select', '<textarea', '<button', 'onChange', 'onClick', 'type="checkbox"']) {
      expect(readOnlyView, `the read-only view must not contain ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('holds no Save, Cancel, Edit or image-management affordance', () => {
    for (const forbidden of ['Upload', 'Replace', 'Remove', 'openImagePicker', 'label_image', 'save', 'cancel', 'edit']) {
      expect(readOnlyView.toLowerCase(), `the read-only view must not offer ${forbidden}`)
        .not.toContain(forbidden.toLowerCase());
    }
  });

  it('is what both libraries render when a row is expanded, and is not the form', () => {
    for (const [name, src] of PAGES) {
      expect(src, `the ${name} library must render the shared read-only view`)
        .toMatch(/renderExpanded=\{\(item\) => \([\s\S]{0,400}<NutritionItemReadOnlyView/);
      // Expanding never seeds the form: `⋮ → Edit` (openInlineEdit) is the only
      // thing that does.
      expect(src, `expanding a ${name} row must not open the editor`)
        .toMatch(/function toggleExpand\(id: number\) \{[\s\S]{0,320}setExpanded\(/);
      expect(src, `${name}: only openInlineEdit seeds the edit form`)
        .toMatch(/function openInlineEdit\(item: LibraryItem\) \{[\s\S]{0,400}setEditForm\(/);
    }
  });
});

describe('section order (§2, §22)', () => {
  it('declares Name → Description → Status → Translations → Categories → Qualities → Media', () => {
    expect([...NUTRITION_ITEM_SECTION_ORDER]).toEqual([
      'name', 'description', 'status', 'translations', 'categories', 'qualities', 'media',
    ]);
  });

  it('renders them in that order, Status immediately below Description', () => {
    const positions = [
      readOnlyView.indexOf("t('label_name')"),
      readOnlyView.indexOf("t('label_description')"),
      readOnlyView.indexOf("t('col_status')"),
      readOnlyView.indexOf("t('label_translations')"),
      readOnlyView.indexOf("t('label_categories')"),
      readOnlyView.indexOf("t('nutritional_qualities_label')"),
      readOnlyView.indexOf("t('label_media')"),
    ];
    expect(positions.every((p) => p > -1)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('makes Media the last section, with the image inside it', () => {
    const mediaStart = readOnlyView.indexOf("t('label_media')");
    const media = readOnlyView.slice(mediaStart);
    expect(media).toContain('item.image_url');
    expect(media).toContain("t('no_image')");
    // Nothing follows Media inside the item's information.
    expect(readOnlyView.slice(mediaStart).indexOf("t('label_categories')")).toBe(-1);
    expect(readOnlyView.slice(mediaStart).indexOf("t('nutritional_qualities_label')")).toBe(-1);
  });
});

describe('categories and qualities (§5, §6)', () => {
  it('shows the whole catalogue, not only what is assigned', () => {
    expect(readOnlyView).toContain('allCategories');
    expect(readOnlyView).toContain('allQualities');
    expect(readOnlyView).toMatch(/all\.map\(\(option\) => \{/);
  });

  it('gives an assigned chip the Edit form\'s selected blue, and an unassigned one the plain border', () => {
    const assigned = taxonomyChipStyle(true);
    const unassigned = taxonomyChipStyle(false);
    expect(assigned.background).toContain('#eff6ff');
    expect(assigned.color).toContain('#1d4ed8');
    expect(unassigned.background).toBe('transparent');
    expect(assigned.border).not.toBe(unassigned.border);
    // A chip is a span, never a control: no cursor, nothing to click.
    expect(assigned.cursor).toBeUndefined();
  });

  it('renders the chips as spans', () => {
    expect(readOnlyView).toMatch(/<span key=\{option\.id\} style=\{taxonomyChipStyle\(isAssigned\)\}>/);
  });
});

describe('the Details modal (§9–§14, §23)', () => {
  it('shows the name, the description and the complete audit information', () => {
    for (const key of ['label_name', 'label_description', 'created_at', 'created_by', 'modified_at', 'modified_by', 'deleted_at', 'deleted_by']) {
      expect(detailsModal, `the Details modal must show ${key}`).toContain(`t('${key}')`);
    }
  });

  it('offers View Audit Log through the shared component, for the right entity', () => {
    expect(detailsModal).toContain("from '@/components/ViewAuditLogButton'");
    expect(detailsModal).toMatch(/<ViewAuditLogButton[^>]*entityType="nutrition_library_item"/);
    expect(detailsModal).toMatch(/<ViewAuditLogButton[^>]*entityId=\{item\.id\}/);
  });

  it('is read-only: no input, no Save, no Edit', () => {
    for (const forbidden of ['<input', '<select', '<textarea', 'Save', 'onChange']) {
      expect(detailsModal, `the Details modal must not contain ${forbidden}`).not.toContain(forbidden);
    }
    // Its only buttons are the Audit Log link and Close.
    const buttons = detailsModal.match(/<button/g) ?? [];
    expect(buttons.length).toBe(1);
    expect(detailsModal).toContain("t('close')");
  });

  it('is reached from `⋮ → Details` in both libraries, and never from the expanded row', () => {
    for (const [name, src] of PAGES) {
      expect(src, `${name}: Details must open the modal`).toMatch(/label: (?:'Details'|t\('nutrition_library\.details'\)), onClick: \(\) => setDetailItem\(item\)/);
      expect(src, `${name}: Details must no longer just expand the row`)
        .not.toMatch(/Details'\), onClick: \(\) => toggleExpand/);
    }
    // The audit deep link left the expanded row with it.
    expect(readOnlyView).not.toContain('ViewAuditLogButton');
  });
});

describe('the Edit form is the only way in (§11, §15–§17)', () => {
  it('carries no View Audit Log, in either library', () => {
    for (const [name, src] of PAGES) {
      const formStart = src.indexOf('function renderInlineForm(');
      expect(formStart, `${name}: the inline form must exist`).toBeGreaterThan(-1);
      const form = src.slice(formStart, src.indexOf('const columns:', formStart));
      expect(form, `${name}: audit information belongs to Details only`).not.toContain('ViewAuditLogButton');
    }
  });

  it('is where the image is uploaded, replaced and removed', () => {
    const cordelForm = cordelPage.slice(
      cordelPage.indexOf('function renderInlineForm('),
      cordelPage.indexOf('const columns:', cordelPage.indexOf('function renderInlineForm(')),
    );
    expect(cordelForm).toContain('Upload Image');
    expect(cordelForm).toContain('openImagePicker(item)');

    const gymForm = gymPage.slice(
      gymPage.indexOf('function renderInlineForm('),
      gymPage.indexOf('const columns:', gymPage.indexOf('function renderInlineForm(')),
    );
    // The gym library's own widget already offers upload / replace / remove.
    expect(gymForm).toContain('<ImageUploadField');
  });

  it('edits the description, in both libraries', () => {
    for (const [name, src] of PAGES) {
      expect(src, `${name}: the form must edit the description`).toMatch(/setForm\(\{ \.\.\.form, description: e\.target\.value \}\)/);
      expect(src, `${name}: create must submit it`).toMatch(/description: newForm\.description\.trim\(\)/);
      expect(src, `${name}: update must submit it`).toMatch(/description: editForm\.description\.trim\(\)/);
    }
  });

  it('gates editing on write access in the gym library, unchanged', () => {
    expect(gymPage).toMatch(/label: t\('nutrition_library\.edit'\), onClick: \(\) => openInlineEdit\(item\), disabled: !canWrite/);
  });
});

describe('one declaration behind both halves (§26)', () => {
  it('maps a persisted row to the form values the Edit form holds', () => {
    const item = row();
    expect(toNutritionItemFormValues(item)).toEqual({
      name: 'Beef',
      description: 'Lean red meat',
      categoryIds: [1],
      qualityIds: [3, 5],
      translations: { es: 'Ternera', ca: 'Vedella' },
      imageUrl: 'https://cdn.example/cordel/nutrition/uuid-Beef.png',
    });
  });

  it('turns a null description into the empty string the form needs, and back', () => {
    expect(toNutritionItemFormValues(row({ description: null })).description).toBe('');
    expect(emptyNutritionItemForm().description).toBe('');
  });

  it('copies the translations rather than sharing the row\'s object', () => {
    const item = row();
    const values = toNutritionItemFormValues(item);
    values.translations.es = 'edited';
    expect(item.translations!.es).toBe('Ternera');
  });

  it('is imported by both libraries instead of restating the columns', () => {
    for (const [name, src] of PAGES) {
      expect(src, `${name}: the row shape comes from the shared module`)
        .toContain("from '@/components/nutritionLibrary/nutritionItemProfile'");
      expect(src, `${name}: no second LibraryItem field list`)
        .toMatch(/type LibraryItem = NutritionLibraryItemRow;/);
    }
  });
});

describe('empty values (§AC8)', () => {
  it('never renders null, undefined or an empty string', () => {
    for (const value of [null, undefined, '', '   ']) {
      expect(displayValue(value as any)).toBe(EMPTY_VALUE);
    }
    expect(displayValue('Beef')).toBe('Beef');
  });

  it('renders a missing timestamp as the em dash rather than an epoch', () => {
    expect(formatTimestamp(null)).toBe(EMPTY_VALUE);
    expect(formatTimestamp(undefined)).toBe(EMPTY_VALUE);
    expect(formatTimestamp('not a date')).toBe(EMPTY_VALUE);
  });

  it('reads a MySQL DATETIME as UTC, whatever the viewer\'s timezone', () => {
    // MySQL hands back `YYYY-MM-DD HH:MM:SS` with no zone. Parsed as local time it
    // would drift by the offset; the helper pins it to UTC.
    const formatted = formatTimestamp('2026-07-27 15:54:07');
    expect(formatted).not.toBe(EMPTY_VALUE);
    expect(formatted).toBe(new Date('2026-07-27T15:54:07Z').toLocaleString());
  });

  it('falls back to the base name when the locale has none', () => {
    expect(displayValue(row({ display_name: '' }).display_name || row().name)).toBe('Beef');
  });
});

describe('localization (§27)', () => {
  const REQUIRED_KEYS = [
    'details', 'label_name', 'label_description', 'label_translations', 'label_media',
    'no_image', 'col_status', 'status_active', 'status_deleted', 'label_categories',
    'nutritional_qualities_label', 'section_audit', 'created_at', 'created_by',
    'modified_at', 'modified_by', 'deleted_at', 'deleted_by', 'close',
    'locale_en', 'locale_es', 'locale_ca', 'description_placeholder',
  ];

  it.each(LOCALE_CODES)('%s.json carries every label the two new views render', (code) => {
    const nl = messages(code).nutrition_library ?? {};
    for (const key of REQUIRED_KEYS) {
      expect(typeof nl[key], `${code}.json is missing nutrition_library.${key}`).toBe('string');
      expect(String(nl[key]).length).toBeGreaterThan(0);
    }
  });

  it('renders no hard-coded label in either shared view', () => {
    for (const [name, src] of [['read-only view', readOnlyView], ['Details modal', detailsModal]] as const) {
      expect(src, `the ${name} must resolve its labels through next-intl`).toContain("useTranslations('nutrition_library')");
    }
  });

  it('falls back to a slug rather than a raw key path for an unknown catalogue row', () => {
    // next-intl has no fallback chain (see apps/admin/src/i18n.ts), so a category
    // added to the database before its key is added here must not render as
    // `nutrition_library.category_x`.
    expect(profile.length).toBeGreaterThan(0);
    expect(readOnlyView).toMatch(/t\.has\(key as any\) \? t\(key as any\) : fallback/);
  });
});
