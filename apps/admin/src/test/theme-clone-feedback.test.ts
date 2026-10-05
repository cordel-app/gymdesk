import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// #1041 §17/§19 — the admin half of the Clone fix. Cloning now copies the
// source theme's logo and every configured Members App background, so it is a
// multi-step storage operation: the user must not be able to start a second one
// while the first is running, must be told while it runs and when it finishes,
// and a failure must name the step that broke — in all three languages.
//
// Sources are scanned, as the rest of apps/admin's tests do (no component test
// infra — docs/architecture.md's TL;DR).

const ROOT = join(__dirname, '..');
const LOCALES_DIR = join(ROOT, '..', 'locales', 'base');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const customPage = stripComments(readFileSync(join(ROOT, 'app', '[locale]', 'themes', 'page.tsx'), 'utf-8'));

const locales = Object.fromEntries(
  LOCALE_CODES.map((c) => [c, JSON.parse(readFileSync(join(LOCALES_DIR, `${c}.json`), 'utf-8'))]),
) as Record<(typeof LOCALE_CODES)[number], Record<string, Record<string, unknown>>>;

describe('a clone in progress cannot be submitted twice (#1041 §17)', () => {
  it('disables the modal while the request is in flight, through the shared modal', () => {
    // `CrudModal` disables both footer buttons on `saving`, so the guard is the
    // app's own rather than a second one spelled here.
    const modal = customPage.match(/<CrudModal open=\{cloning !== null\}[\s\S]*?>/)?.[0] ?? '';
    expect(modal).toContain('saving={cloneSaving}');
    expect(modal).toContain("saveLabel={cloneSaving ? t('clone_saving') : t('clone_save')}");
  });

  it('says what is happening and that it finished', () => {
    const handler = customPage.match(/async function handleClone\(\)[\s\S]*?\n {2}}/)?.[0] ?? '';
    expect(handler).toContain('setCloneSaving(true)');
    expect(handler).toContain("toast(t('toast_cloned'), 'success')");
    // The success toast fires only after the request resolved, never beside it.
    expect(handler.indexOf('apiFetch(')).toBeLessThan(handler.indexOf("toast(t('toast_cloned')"));
    // And the flag is always cleared, success or failure.
    expect(handler).toContain('setCloneSaving(false)');
  });

  it('keeps the failure diagnostic the storage stages feed', () => {
    // The stage comes off the response body, so the two stages #1041 adds
    // render without the page naming either of them.
    const handler = customPage.match(/async function handleClone\(\)[\s\S]*?\n {2}}/)?.[0] ?? '';
    expect(handler).toContain('err.body?.stage');
    expect(handler).toContain("storageErrorMessage(err, 'storage_error_title_clone', 'create_theme_folder')");
    expect(customPage).not.toContain('copy_logo');
    expect(customPage).not.toContain('copy_members_image');
  });
});

describe('the clone copy messages are translated (#1041 §19)', () => {
  it('has the two new storage stages in both theme namespaces, in en, es and ca', () => {
    // The admin interpolates the wire value into `storage_stage_<value>`, and
    // next-intl prints a missing key verbatim.
    for (const code of LOCALE_CODES) {
      for (const ns of ['gym_themes', 'themes']) {
        for (const key of ['storage_stage_copy_logo', 'storage_stage_copy_members_image']) {
          const value = locales[code][ns][key];
          expect(value, `${code}.${ns}.${key}`).toBeTypeOf('string');
          expect((value as string).length).toBeGreaterThan(0);
        }
      }
    }
  });

  it('has the in-progress and success copy in en, es and ca', () => {
    for (const code of LOCALE_CODES) {
      for (const key of ['clone_saving', 'toast_cloned']) {
        const value = locales[code].gym_themes[key];
        expect(value, `${code}.gym_themes.${key}`).toBeTypeOf('string');
        expect((value as string).length).toBeGreaterThan(0);
      }
    }
  });

  it('still states the uninitialized-bucket reason before anything is created (§1)', () => {
    // #827's messages, which #1041 §1 asks for and does not change.
    for (const code of LOCALE_CODES) {
      for (const key of ['clone_not_configured', 'clone_not_initialized']) {
        expect(locales[code].gym_themes[key], `${code}.gym_themes.${key}`).toBeTypeOf('string');
      }
    }
    const handler = customPage.match(/async function handleClone\(\)[\s\S]*?\n {2}}/)?.[0] ?? '';
    expect(handler.indexOf('if (storageBlock)')).toBeLessThan(handler.indexOf('apiFetch('));
  });
});
