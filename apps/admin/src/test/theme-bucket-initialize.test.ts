import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { formatStorageError, formatStorageErrorLine } from '../lib/storageErrorMessage';

// #828 — "Initialize bucket" on a Theme's context menu: a manual, explicitly
// repeatable way to create the Cloudflare folders a Theme's own assets live in.
//
// The two pages administer two different roots — a Custom Theme's folder hangs
// off its gym's prefix and a Base Theme's off `cordel/` — so each calls its own
// route, and only the gym-facing one is gated by the gym's bucket (#823).
//
// The formatter is pure, so it is asserted directly; the wiring is pinned by
// scanning sources, as the rest of apps/admin's tests do (no component test
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

const LABELS = {
  title: 'Initializing the theme bucket failed.',
  operation: 'Operation',
  path: 'Path',
  error: 'Error',
  details: 'Details',
  operationName: 'Create the Logo folder',
};

describe('formatStorageErrorLine() (#828)', () => {
  const err = {
    message: 'Failed to create the theme storage folders: Unauthorized',
    status: 502,
    body: {
      error: 'Failed to create the theme storage folders: Unauthorized',
      stage: 'create_logo_folder',
      path: 'gyms/123-QSport/themes/456-CrimsonBase/logo/',
      details: {
        operation: 'ensureStorageFolders',
        message: 'Unauthorized',
        name: 'AccessDenied',
        httpStatusCode: 401,
        key: 'gyms/123-QSport/themes/456-CrimsonBase/logo/',
      },
    },
  };

  it('says the same things as the block form, on a single line', () => {
    const line = formatStorageErrorLine(err, LABELS);
    expect(line).not.toContain('\n');
    expect(line).toContain('Initializing the theme bucket failed.');
    expect(line).toContain('Operation: Create the Logo folder');
    expect(line).toContain('Path: gyms/123-QSport/themes/456-CrimsonBase/logo/');
    expect(line).toContain('Error: Failed to create the theme storage folders: Unauthorized (401)');
    expect(line).toContain('AccessDenied');
  });

  it('carries every part the block form does — it is the same formatter', () => {
    const line = formatStorageErrorLine(err, LABELS);
    for (const part of formatStorageError(err, LABELS).split('\n').filter((l) => l !== '')) {
      expect(line).toContain(part);
    }
  });

  it('still says what it can for a failure that never reached storage', () => {
    const line = formatStorageErrorLine(
      { message: 'Unauthorized', status: 401, body: { error: 'Unauthorized' } },
      LABELS,
    );
    expect(line).toContain('Initializing the theme bucket failed.');
    expect(line).toContain('Operation: Create the Logo folder');
    expect(line).toContain('Error: Unauthorized (401)');
    expect(line).not.toContain('Path:');
  });
});

describe('the Custom Themes context menu initializes the Theme bucket (#828 §1)', () => {
  it('calls the gym-scoped route, with the Theme id and nothing client-derived', () => {
    // #1042: the handler takes the Theme id rather than the row, because the
    // error block offers the same action and has only the id in scope.
    expect(customPage).toContain("apiFetch(`/system/themes/${themeId}/storage/initialize`, { method: 'POST' })");
  });

  it('offers the action in the ⋮ menu', () => {
    expect(customPage).toContain("label: t('action_initialize_bucket')");
    expect(customPage).toContain('onClick: () => handleInitializeBucket(theme.id)');
  });

  it('is disabled with the reason while the gym bucket cannot be written to (#823, §5)', () => {
    const item = customPage.slice(customPage.indexOf("label: t('action_initialize_bucket')"));
    expect(item).toContain('disabled: !!storageBlock');
    expect(item).toContain('title: storageBlock ? t(`initialize_bucket_${storageBlock}`) : undefined');
    // The handler refuses too: a disabled menu item is not the only entry point.
    expect(customPage).toContain('if (storageBlock) { toast(t(`initialize_bucket_${storageBlock}`)); return; }');
  });

  it('confirms success and reports a failure with the step that broke (§4)', () => {
    expect(customPage).toContain("toast(t('toast_bucket_initialized'), 'success')");
    expect(customPage).toContain("storageErrorLine(err, 'storage_error_title_initialize_bucket', 'create_theme_folder')");
    expect(customPage).toContain('formatStorageErrorLine');
  });

  it('never offers the action for a Base Theme — the platform root is not a gym\'s', () => {
    // The item sits inside the `!isDeleted && !theme.is_base` branch, which is
    // also what keeps Delete off a Base Theme.
    const branch = customPage.slice(
      customPage.indexOf('if (!isDeleted && !theme.is_base) {'),
      customPage.indexOf("menuItems.push({ label: t('details')"),
    );
    expect(branch).toContain("label: t('action_initialize_bucket')");
  });
});

describe('the Base Themes context menu initializes the Theme bucket (#828 §2)', () => {
  it('calls the platform route', () => {
    expect(basePage).toContain("apiFetch(`/platform/themes/${themeId}/storage/initialize`, { method: 'POST' })");
  });

  it('offers the action in the ⋮ menu and confirms or reports the outcome (§4)', () => {
    expect(basePage).toContain("label: t('action_initialize_bucket')");
    expect(basePage).toContain('onClick: () => handleInitializeBucket(th.id)');
    expect(basePage).toContain("toast(t('toast_bucket_initialized'), 'success')");
    expect(basePage).toContain("storageErrorLine(err, 'storage_error_title_initialize_bucket', 'create_theme_folder')");
  });

  it('is not gated by a gym\'s bucket — a Base Theme\'s objects are the platform\'s (#823)', () => {
    const item = basePage.slice(basePage.indexOf("label: t('action_initialize_bucket')"));
    expect(item).not.toContain('storageBlock');
    expect(basePage).not.toContain('gymStorageBlock');
  });
});

describe('every label exists in every locale (#828)', () => {
  // next-intl prints a missing key verbatim, and the two block keys are
  // interpolated from the block value — a missing one would put
  // `gym_themes.initialize_bucket_not_initialized` in the menu item's tooltip.
  const SHARED_KEYS = [
    'action_initialize_bucket',
    'toast_bucket_initialized',
    'storage_error_title_initialize_bucket',
  ];
  const GYM_ONLY_KEYS = ['initialize_bucket_not_configured', 'initialize_bucket_not_initialized'];

  it.each(LOCALE_CODES)('%s carries the action in both theme namespaces', (code) => {
    for (const ns of ['themes', 'gym_themes']) {
      for (const key of SHARED_KEYS) expect(locales[code][ns]).toHaveProperty(key);
    }
    for (const key of GYM_ONLY_KEYS) expect(locales[code].gym_themes).toHaveProperty(key);
  });
});
