import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { gymStorageBlock } from '../lib/gymStorageReadiness';

// #827 — a Custom Theme's assets live in the gym's own Cloudflare folder, so a
// Theme cannot be created before that folder tree exists. The API refuses it
// (503 for an unconfigured deployment, 409 for an uninitialized gym) and creates
// no row; this is the half that says so before the admin types a name, reusing
// #823's one readiness rule rather than a second copy of it.
//
// Sources are scanned, as the rest of apps/admin's tests do (no component test
// infra — docs/architecture.md's TL;DR).

const ROOT = join(__dirname, '..');
const LOCALES_DIR = join(ROOT, '..', 'locales', 'base');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const read = (...parts: string[]) => stripComments(readFileSync(join(ROOT, ...parts), 'utf-8'));

const customPage = read('app', '[locale]', 'themes', 'page.tsx');
const basePage = read('app', '[locale]', 'system', 'themes', 'page.tsx');

const locales = Object.fromEntries(
  LOCALE_CODES.map((c) => [c, JSON.parse(readFileSync(join(LOCALES_DIR, `${c}.json`), 'utf-8'))]),
) as Record<(typeof LOCALE_CODES)[number], Record<string, Record<string, unknown>>>;

describe('Clone Theme is unavailable while the gym bucket is not initialized (#827)', () => {
  it('reuses the one readiness rule rather than re-deriving the pair', () => {
    // The page already takes the decision once for its uploads (#823); creating
    // a theme is the same decision about the same folder.
    expect(customPage).toContain('const storageBlock = gymStorageBlock(activeGym);');
    expect((customPage.match(/gymStorageBlock\(/g) ?? []).length).toBe(1);
  });

  it('disables the ⋮ → Clone item and states the reason as its tooltip', () => {
    const cloneItem = customPage.match(/\{\s*label: t\('clone'\)[\s\S]*?\},/)?.[0] ?? '';
    expect(cloneItem).toContain('disabled: !!storageBlock');
    expect(cloneItem).toContain('title: storageBlock ? t(`clone_${storageBlock}`) : undefined');
  });

  it('refuses the submit too, so a modal opened earlier cannot create a theme', () => {
    const handler = customPage.match(/async function handleClone\(\)[\s\S]*?\n {2}}/)?.[0] ?? '';
    expect(handler).toContain('if (storageBlock)');
    expect(handler).toContain('t(`clone_${storageBlock}`)');
    // Before the request is made, not after it fails.
    expect(handler.indexOf('if (storageBlock)')).toBeLessThan(handler.indexOf('apiFetch('));
  });

  it('renders a failed creation with the same stage diagnostic as every other storage save (#824)', () => {
    const handler = customPage.match(/async function handleClone\(\)[\s\S]*?\n {2}}/)?.[0] ?? '';
    expect(handler).toContain("storageErrorMessage(err, 'storage_error_title_clone', 'create_theme_folder')");
    // Only for a failure that reached storage: a duplicate name is a 409 with no
    // `stage`, and a folder step named for it would misdescribe it.
    expect(handler).toContain('err.body?.stage');
    expect(handler).toContain("err.message ?? t('error_generic')");
  });

  it('leaves the rest of the clone flow alone', () => {
    // The name is still the only input, and the empty-name check still comes first.
    const handler = customPage.match(/async function handleClone\(\)[\s\S]*?\n {2}}/)?.[0] ?? '';
    expect(handler.indexOf("t('error_required')")).toBeLessThan(handler.indexOf('if (storageBlock)'));
    expect(customPage).toContain('/system/themes/clone/');
    // And the page still names no storage path of its own.
    expect(customPage).not.toContain('storage_folder_prefix');
  });

  it('does not gate the Base Themes page, whose objects are the platform’s', () => {
    // A Base Theme is created under `cordel/…`, which no gym's bucket governs.
    expect(basePage).not.toContain('gymStorageBlock');
    expect(basePage).not.toContain('storageBlock');
  });
});

describe('the blocked-creation messages are translated (#827)', () => {
  const keys = ['clone_not_configured', 'clone_not_initialized', 'storage_error_title_clone'];

  it('exists in en, es and ca', () => {
    for (const code of LOCALE_CODES) {
      for (const key of keys) {
        const value = locales[code].gym_themes[key];
        expect(value, `${code}.gym_themes.${key}`).toBeTypeOf('string');
        expect((value as string).length).toBeGreaterThan(0);
      }
    }
  });

  it('names one key per block reason, so a reason can never render as a key', () => {
    // next-intl prints a missing key verbatim and the key is interpolated from
    // the block value, so every value the rule can take needs its own key.
    for (const gym of [
      { storage_configured: false, storage_folder_prefix: null },
      { storage_configured: true, storage_folder_prefix: null },
    ]) {
      expect(keys).toContain(`clone_${gymStorageBlock(gym)}`);
    }
    expect(gymStorageBlock({ storage_configured: true, storage_folder_prefix: 'gyms/7-Gym' })).toBeNull();
  });
});
