import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// Regression test for #643 — Translate Nutrition Library Content.
//
// Two things must stay true on the frontend, and both are easy to undo by
// accident:
//   1. Every app request carries `x-locale`, and both proxies forward it —
//      otherwise the API silently resolves everything to English and the
//      feature looks broken with no error anywhere.
//   2. Read surfaces render `display_name` (the localized value) while edit
//      forms round-trip `name` (the base value). Prefilling a form from the
//      translation would overwrite the English original on save.
//
// This repo has no component-test infra for apps/admin (see docs/architecture.md's
// TL;DR), so — like additional-periodic-services.test.ts (#631) — this pins the
// structure down by scanning the source.

const SRC = join(__dirname, '..');
const MEMBER_SRC = join(SRC, '..', '..', 'member', 'src');

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function read(path: string): string {
  return stripComments(readFileSync(path, 'utf-8'));
}

const adminApiClient = read(join(SRC, 'lib', 'apiClient.ts'));
const memberApiClient = read(join(MEMBER_SRC, 'lib', 'apiClient.ts'));
const adminProxy = read(join(SRC, 'app', 'api', 'proxy', '[...path]', 'route.ts'));
const memberProxy = read(join(MEMBER_SRC, 'app', 'api', 'proxy', '[...path]', 'route.ts'));
const cordelPage = read(join(SRC, 'app', '[locale]', 'cordel', 'nutrition-library', 'page.tsx'));
const gymPage = read(join(SRC, 'app', '[locale]', 'nutrition', 'nutrition-library', 'page.tsx'));
const planTree = read(join(SRC, 'app', '[locale]', 'nutrition', 'nutrition-plan-templates', 'NutritionPlanTree.tsx'));

describe('x-locale plumbing', () => {
  it('both API clients read the active locale and send it as x-locale', () => {
    for (const src of [adminApiClient, memberApiClient]) {
      expect(src).toMatch(/useLocale\s*\}?\s*from\s*'next-intl'|useLocale\(\)/);
      expect(src).toContain("headers['x-locale']");
    }
  });

  it('the admin client re-creates apiFetch when the locale changes', () => {
    // apiFetch is memoized: omitting `locale` from the dependency array would
    // pin every request to whichever locale was active on first render.
    const deps = adminApiClient.match(/\[\s*getToken[^\]]*\]/);
    expect(deps?.[0]).toContain('locale');
  });

  it('both proxies forward x-locale to the API', () => {
    for (const src of [adminProxy, memberProxy]) {
      expect(src).toContain("'x-locale'");
    }
  });
});

describe('base name vs. displayed name', () => {
  it('the Cordel page edits the base name, never the localized one', () => {
    // openInlineEdit must seed the form from `item.name`.
    expect(cordelPage).toMatch(/setEditForm\(\{[\s\S]{0,200}name:\s*item\.name/);
    expect(cordelPage).not.toMatch(/setEditForm\(\{[\s\S]{0,200}name:\s*item\.display_name/);
  });

  it('the Cordel page submits a translations object on create and update', () => {
    const submits = cordelPage.match(/translations:\s*trimmedTranslations\(/g) ?? [];
    expect(submits.length).toBe(2);
  });

  it('the Cordel page renders one name field per translatable locale, from the API', () => {
    expect(cordelPage).toContain('/platform/nutrition-library/locales');
    expect(cordelPage).toMatch(/translatableLocales\.map\(/);
  });

  it('blank translation fields are dropped rather than saved as empty strings', () => {
    expect(cordelPage).toMatch(/function trimmedTranslations/);
    expect(cordelPage).toMatch(/if \(trimmed\) out\[locale\] = trimmed;/);
  });

  it('the gym-facing library list renders the localized name', () => {
    expect(gymPage).toMatch(/item\.display_name \?\? item\.name/);
  });

  it('the gym-facing edit form still round-trips the base name', () => {
    expect(gymPage).toMatch(/setEditForm\(\{[\s\S]{0,260}name:\s*item\.name/);
  });

  it('the food pickers in the plan tree show the localized name', () => {
    expect(planTree).toMatch(/item\.display_name \?\? item\.name/);
  });
});
