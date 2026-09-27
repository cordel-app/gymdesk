import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// #812 — the Food Type selector showed `nutrition_plan_templates.tree_component_type_undefined`.
//
// Root cause: migration 142 (#501) replaced `nutrition_library_items.category`
// (a scalar) with the `nutrition_library_categories` catalogue plus an M2M
// junction, and `GET /nutrition-library` has returned `categories: [{id, slug}]`
// ever since. NutritionPlanTree kept reading the dropped `category` field, so
// every food's food type was `undefined`: the option list was `[undefined]` and
// the label resolved to the key with `undefined` in it. The `{ defaultValue }`
// that was supposed to catch this does nothing — next-intl's `t()` has no such
// option and prints a missing key verbatim.
//
// The fix reads `categories`, takes the options from the router serving the tree
// (an assigned plan's meal items accept a narrower set than a template's), and
// routes every label through one helper that can never emit a raw key.
//
// This repo has no component-test infra for apps/admin (see docs/architecture.md's
// TL;DR), so this pins the structure down by scanning the source and the locales.

const SRC = join(__dirname, '..');
const TREE_PATH = join(
  SRC, 'app', '[locale]', 'nutrition', 'nutrition-plan-templates', 'NutritionPlanTree.tsx',
);
const LOCALES_DIR = join(SRC, '..', 'locales', 'base');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const raw = readFileSync(TREE_PATH, 'utf-8');
const treeSrc = stripComments(raw);

describe('#812 the Nutrition Library food is read through `categories`', () => {
  it('never reads the scalar `category` migration 142 dropped', () => {
    // `.category` on a library item is the defect. `item_category` (the
    // restriction row's GROUP_CONCAT of slugs) and `categories` are fine.
    expect(treeSrc).not.toMatch(/\.category\b(?![_a-zA-Z])/);
  });

  it('maps the API\'s `categories: [{id, slug}]` into a list of slugs', () => {
    expect(treeSrc).toContain('categories: Array.isArray(item.categories) ? item.categories.map((c) => c.slug) : []');
  });

  it('filters the Food dropdown with `categories.includes(...)`, not equality', () => {
    expect(treeSrc).toContain('foods.filter((i) => i.categories.includes(addFoodType))');
    expect(treeSrc).toContain('foods.filter((i) => i.categories.includes(editState.foodType))');
  });
});

describe('#812 the Food Type options come from the backend', () => {
  it('fetches them from the router serving this tree', () => {
    // Not hardcoded: `/member-nutrition-plans` accepts four types and
    // `/nutrition-plan-templates` seven, and `apiBase` is what tells them apart.
    expect(treeSrc).toContain('`${apiBase}/component-types`');
  });

  it('offers a type only when it is accepted here and a food carries it', () => {
    expect(treeSrc).toContain('const availableFoodTypes = componentTypes.filter(');
    expect(treeSrc).toContain('foodCategories.has(ct) || storedTypes.has(ct)');
  });

  it('keeps a type already stored on an item selectable', () => {
    // Otherwise editing such an item would silently change its Food Type.
    expect(treeSrc).toContain('const storedTypes = new Set(items.map((i) => i.component_type));');
  });

  it('threads the options down to the editor rather than refetching per meal', () => {
    for (const marker of [
      'componentTypes={componentTypes}',
      'componentTypes: string[];',
    ]) {
      expect(treeSrc).toContain(marker);
    }
  });
});

describe('#812 reopening an item shows the Food Type it was saved with', () => {
  it('seeds the edit form from the stored component_type', () => {
    expect(treeSrc).toContain(
      'foodType: storedIsStillACategory ? item.component_type : (fallbackType ?? item.component_type),',
    );
  });

  it('falls back only to a category this surface also accepts', () => {
    expect(treeSrc).toContain('const fallbackType = libItem?.categories.find((c) => componentTypes.includes(c));');
  });

  it('no longer prefers the food\'s own category over the stored value', () => {
    expect(treeSrc).not.toContain('libItem?.category ?? item.component_type');
  });
});

describe('#812 no raw translation key can reach the screen', () => {
  it('routes every Food Type label through the one helper', () => {
    expect(treeSrc).toContain('function foodTypeLabel(slug: string, translate: (key: string) => string): string');
    // The helper is the only place that builds the key.
    const keyUses = treeSrc.match(/tree_component_type_\$\{/g) ?? [];
    expect(keyUses).toHaveLength(1);
  });

  it('drops the `defaultValue` option, which next-intl ignores', () => {
    expect(treeSrc).not.toMatch(/tree_component_type_\$\{[^}]*\}`,\s*\{\s*defaultValue/);
  });

  it('falls back to the slug for a type with no label', () => {
    expect(treeSrc).toMatch(/\?\s*translate\(`nutrition_plan_templates\.tree_component_type_\$\{slug\}`\)\s*:\s*slug/);
  });

  it('labels the Dietary Restrictions picker instead of printing `undefined`', () => {
    expect(treeSrc).toContain('o.categories.map((c) => foodTypeLabel(c, t)).join(\', \')');
  });
});

describe('#812 every Food Type has a label in every locale', () => {
  // The seven the template CHECK accepts (migration 111); the assigned-plan set
  // is a subset, so covering these covers both surfaces.
  const SLUGS = ['main_dish', 'side', 'sauce', 'drink', 'dessert', 'other', 'additional'];

  for (const locale of LOCALE_CODES) {
    it(`${locale}.json has all seven`, () => {
      const messages = JSON.parse(readFileSync(join(LOCALES_DIR, `${locale}.json`), 'utf-8'));
      const section = messages.nutrition_plan_templates ?? {};
      for (const slug of SLUGS) {
        expect(section[`tree_component_type_${slug}`], slug).toBeTruthy();
      }
    });
  }

  it('no locale defines a label for `undefined`', () => {
    // The ticket's explicit "do not do this" (AC7).
    for (const locale of LOCALE_CODES) {
      const messages = JSON.parse(readFileSync(join(LOCALES_DIR, `${locale}.json`), 'utf-8'));
      expect(messages.nutrition_plan_templates?.tree_component_type_undefined).toBeUndefined();
    }
  });
});
