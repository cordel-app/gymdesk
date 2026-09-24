import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// #712 — the Custom Themes header shows who created a theme, when, and whether
// it is the theme the gym is currently using.
//
// This repo has no component-test infra for apps/admin (see docs/architecture.md's
// TL;DR), so — like theme-editor-unification.test.ts (#678) — this pins the
// behaviour down by scanning the page source and the locale files.

const SRC = join(__dirname, '..');
const CUSTOM_PAGE = join(SRC, 'app', '[locale]', 'themes', 'page.tsx');
const LOCALES_DIR = join(SRC, '..', 'locales', 'base');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;

type Messages = Record<string, Record<string, unknown>>;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '').replace(/^\s*\/\/.*$/gm, '');
}

const page = stripComments(readFileSync(CUSTOM_PAGE, 'utf-8'));

const locales = Object.fromEntries(
  LOCALE_CODES.map((c) => [c, JSON.parse(readFileSync(join(LOCALES_DIR, `${c}.json`), 'utf-8'))]),
) as Record<(typeof LOCALE_CODES)[number], Messages>;

/** The `renderThemeRow` body — the card header, i.e. everything before the inline editor. */
function headerSource(): string {
  const start = page.indexOf('function renderThemeRow');
  expect(start, 'renderThemeRow not found in the Custom Themes page').toBeGreaterThan(-1);
  const editorMount = page.indexOf('{isExpanded && renderInlineEditor(theme)}', start);
  expect(editorMount, 'the inline editor mount point moved').toBeGreaterThan(start);
  return page.slice(start, editorMount);
}

describe('Custom Themes header metadata (#712)', () => {
  it('reads the creator from the API response, not from a second source', () => {
    expect(page).toContain('created_by_name: string | null;');
    expect(headerSource()).toContain('theme.created_by_name');
    // No client-side reconstruction of the creator from audit logs or actors.
    expect(page).not.toMatch(/audit-logs\?[^'"`]*action=/);
  });

  it('renders creator and creation date in the header, not only in the Details modal', () => {
    const header = headerSource();
    expect(header).toContain("t('meta_created_by')");
    expect(header).toContain("t('meta_created_at')");
    expect(header).toContain('formatDate(theme.created_at)');
  });

  it('falls back to an em dash for a theme with no recorded creator', () => {
    expect(headerSource()).toContain("theme.created_by_name ?? '—'");
  });

  it('derives the gym-theme badge from the API flag (gyms.theme_id), never from the name', () => {
    const header = headerSource();
    expect(page).toContain('is_gym_theme: boolean;');
    expect(header).toContain('theme.is_gym_theme &&');
    expect(header).toContain("t('badge_gym_theme')");
    // The badge is conditional, so only the assigned theme shows it.
    expect(header).not.toMatch(/is_gym_theme\s*\|\|/);
  });

  it('leaves the Base Theme rows without gym-side creator metadata', () => {
    expect(headerSource()).toContain('!theme.is_base && (');
  });

  it('adds the creator to the Details modal alongside the existing dates', () => {
    expect(page).toContain("t('details_created_by')");
    expect(page).toContain("t('details_created_at')");
  });

  it('translates every new label in all three locales', () => {
    // next-intl has no locale fallback (apps/admin/src/i18n.ts) — a key missing
    // from one namespace renders as its raw dotted path.
    for (const code of LOCALE_CODES) {
      const ns = locales[code].gym_themes as Record<string, string>;
      for (const key of ['badge_gym_theme', 'meta_created_by', 'meta_created_at', 'details_created_by']) {
        expect(ns[key], `gym_themes.${key} missing from ${code}.json`).toBeTruthy();
      }
    }
  });
});
