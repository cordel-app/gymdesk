import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { gymStorageBlock } from '../lib/gymStorageReadiness';

// #823 — a Theme logo and a Members App background are objects in the gym's own
// Cloudflare folder, so both upload controls have to be unusable while that
// folder cannot be written to. The API already refuses those two cases (503 for
// an unconfigured deployment, 409 for an uninitialized gym); this is the half
// that stops the admin picking a file and finding out afterwards.
//
// The rule itself is a pure function, so it is asserted directly. The wiring is
// pinned by scanning sources, as the rest of apps/admin's tests do (no component
// test infra — docs/architecture.md's TL;DR).

const ROOT = join(__dirname, '..');
const LOCALES_DIR = join(ROOT, '..', 'locales', 'base');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const read = (...parts: string[]) => stripComments(readFileSync(join(ROOT, ...parts), 'utf-8'));

const customPage = read('app', '[locale]', 'themes', 'page.tsx');
const basePage = read('app', '[locale]', 'system', 'themes', 'page.tsx');
const brandingEditor = read('components', 'ThemeSectionEditor.tsx');
const membersEditor = read('components', 'ThemeMembersImagesEditor.tsx');
const helper = read('lib', 'gymStorageReadiness.ts');

const locales = Object.fromEntries(
  LOCALE_CODES.map((c) => [c, JSON.parse(readFileSync(join(LOCALES_DIR, `${c}.json`), 'utf-8'))]),
) as Record<(typeof LOCALE_CODES)[number], Record<string, Record<string, unknown>>>;

const READY = { storage_configured: true, storage_folder_prefix: 'gyms/7-Gym' };

describe('gymStorageBlock() — the one readiness rule (#823)', () => {
  it('blocks every gym when the deployment has no R2 credentials', () => {
    expect(gymStorageBlock({ storage_configured: false, storage_folder_prefix: null })).toBe('not_configured');
    // An unconfigured deployment outranks the per-gym state: a stale prefix from
    // before the credentials were removed still cannot be written to.
    expect(gymStorageBlock({ storage_configured: false, storage_folder_prefix: 'gyms/7-Gym' })).toBe('not_configured');
  });

  it('blocks a gym whose bucket folders were never initialized', () => {
    // No `storage_folder_prefix` means Gym Bucket Initialization never ran, so
    // neither the gym root nor the `themes/` branch under it exists (#735) and
    // there is no prefix to build a key from.
    expect(gymStorageBlock({ storage_configured: true, storage_folder_prefix: null })).toBe('not_initialized');
    expect(gymStorageBlock({ storage_configured: true, storage_folder_prefix: '' })).toBe('not_initialized');
  });

  it('allows an initialized gym on a configured deployment', () => {
    expect(gymStorageBlock(READY)).toBeNull();
  });

  it('does not block on a state nobody has read yet', () => {
    // The gym list is still loading: a control is not declared unavailable on
    // the strength of an absent gym.
    expect(gymStorageBlock(null)).toBeNull();
    expect(gymStorageBlock(undefined)).toBeNull();
  });

  it('never consults a gym for an upload that does not go into one', () => {
    // A Base Theme's slots and a Base Exercise's media live under the platform
    // root (`cordel/…`), which no gym's storage settings gate — so the
    // superadmin's currently selected gym must not be able to block them.
    for (const gym of [
      { storage_configured: false, storage_folder_prefix: null },
      { storage_configured: true, storage_folder_prefix: null },
      READY,
    ]) {
      expect(gymStorageBlock(gym, false)).toBeNull();
    }
  });

  it('is the only implementation of the rule', () => {
    // Every per-gym upload control reads the pair through the helper; a fourth
    // inline copy is what this consolidated.
    for (const src of [
      read('components', 'ExerciseImageField.tsx'),
      read('components', 'ExerciseVideoField.tsx'),
      read('components', 'ImageUploadField.tsx'),
    ]) {
      expect(src).toContain('gymStorageBlock(');
      expect(src).not.toMatch(/activeGym\.storage_configured/);
      expect(src).not.toMatch(/activeGym\.storage_folder_prefix/);
    }
    // And the helper is the one place either column is named.
    expect(helper).toContain('storage_configured');
    expect(helper).toContain('storage_folder_prefix');
  });
});

describe('Custom Themes: uploads are disabled while storage is unavailable (#823)', () => {
  it('takes the decision once on the page and hands it to both editors', () => {
    expect(customPage).toContain("import { gymStorageBlock } from '@/lib/gymStorageReadiness'");
    expect(customPage).toContain('const storageBlock = gymStorageBlock(activeGym);');
    expect(customPage).toMatch(/<ThemeBrandingEditor[\s\S]*?storageBlock=\{storageBlock\}/);
    expect(customPage).toMatch(/<ThemeMembersImagesEditor[\s\S]*?storageBlock=\{storageBlock\}/);
    // The page keeps naming only the slot, never a storage path (#725's rule).
    expect(customPage).not.toContain('storage_folder_prefix');
    expect(customPage).not.toContain('object_key');
  });

  it('disables the logo button and its file input, so no picker opens', () => {
    const logoBlock = brandingEditor.match(/\{!readOnly && \([\s\S]*?\n {10}\)\}/)?.[0] ?? '';
    expect(logoBlock).toContain('disabled={storageBlock !== null}');
    // Both of them: a disabled button alone still leaves `input.click()` usable.
    expect((logoBlock.match(/disabled=\{storageBlock !== null\}/g) ?? []).length).toBe(2);
    expect(logoBlock).toContain('title={storageBlock ? t(`logo_upload_${storageBlock}`) : undefined}');
    // Disabled reads as disabled: the shared `readOnlyStyle()` treatment.
    expect(logoBlock).toContain("readOnlyStyle(btnSmall('#444'), storageBlock !== null)");
  });

  it('disables every Members App slot and its file input', () => {
    expect((membersEditor.match(/disabled=\{storageBlock !== null\}/g) ?? []).length).toBe(2);
    expect(membersEditor).toContain('title={storageBlock ? t(`members_image_upload_${storageBlock}`) : undefined}');
    expect(membersEditor).toContain("readOnlyStyle(btnSmall('#444'), storageBlock !== null)");
    // One decision for the section, passed down to each slot.
    expect(membersEditor).toMatch(/<MemberImageSlotField[\s\S]*?storageBlock=\{storageBlock\}/);
  });

  it('states the reason instead of failing silently', () => {
    expect(brandingEditor).toMatch(/\{storageBlock && \([\s\S]*?t\(`logo_upload_\$\{storageBlock\}`\)/);
    expect(membersEditor).toMatch(/storageBlock && \([\s\S]*?t\(`members_image_upload_\$\{storageBlock\}`\)/);
  });

  it('leaves the rest of both sections alone', () => {
    // §"No changes are made to the existing logo display, the gym-name option,
    // or the supported formats/size limits": the block gates the upload only.
    expect(brandingEditor).toContain("t('logo_contains_gym_name')");
    expect(brandingEditor).toContain('accept="image/png,image/svg+xml,image/jpeg,image/webp"');
    expect(brandingEditor).toMatch(/onClick=\{onLogoRemove\} style=\{btnSmall\('#c0392b'\)\}/);
    expect(membersEditor).toContain("t('members_image_remove')");
    expect(membersEditor).toContain('MEMBER_IMAGE_ACCEPT');
    expect(membersEditor).toContain('MEMBER_IMAGE_MAX_BYTES');
  });

  it('never stages a file for an upload that cannot happen', () => {
    // The controls are disabled, so this is belt and braces — but a staged file
    // would otherwise be uploaded by Save, which is the "silently accepted
    // upload with no effect" the ticket is about.
    const pick = customPage.match(/function handleLogoPick[\s\S]*?\n {2}}/)?.[0] ?? '';
    expect(pick).toContain('if (storageBlock)');
    expect(pick.indexOf('if (storageBlock)')).toBeLessThan(pick.indexOf('setEditLogoFile(file)'));
    const pickMembers = customPage.match(/function pickMembersImage[\s\S]*?\n {2}}/)?.[0] ?? '';
    expect(pickMembers).toContain('if (storageBlock)');
    expect(pickMembers.indexOf('if (storageBlock)')).toBeLessThan(pickMembers.indexOf('setMembersImageFiles'));
  });
});

describe('Base Themes are not gated on a gym’s bucket (#823)', () => {
  it('passes no storage block, because its objects are the platform’s', () => {
    // A Base Theme's Members images live under `cordel/themes/…` and its logo is
    // a blob on the row — neither hangs off `gyms.storage_folder_prefix`, so the
    // superadmin's currently selected gym must not be able to block them.
    expect(basePage).not.toContain('storageBlock');
    expect(basePage).not.toContain('gymStorageBlock');
  });

  it('defaults the prop to "not blocked" in both shared editors', () => {
    expect(brandingEditor).toContain('storageBlock = null');
    expect(membersEditor).toContain('storageBlock = null');
  });
});

describe('the blocked-upload messages are translated (#823)', () => {
  const keys = [
    'logo_upload_not_configured',
    'logo_upload_not_initialized',
    'members_image_upload_not_configured',
    'members_image_upload_not_initialized',
  ];

  it('exists in en, es and ca, for both theme namespaces', () => {
    for (const code of LOCALE_CODES) {
      for (const ns of ['gym_themes', 'themes'] as const) {
        for (const key of keys) {
          const value = locales[code][ns][key];
          expect(value, `${code}.${ns}.${key}`).toBeTypeOf('string');
          expect((value as string).length).toBeGreaterThan(0);
        }
      }
    }
  });

  it('names one key per block reason, so a reason can never render as a key', () => {
    // next-intl prints a missing key verbatim, and the key is interpolated from
    // the block value — so every value `GymStorageBlock` can take needs a key.
    const declared = [...helper.matchAll(/'(not_[a-z]+)'/g)].map((m) => m[1]);
    expect(new Set(declared)).toEqual(new Set(['not_configured', 'not_initialized']));
    for (const reason of new Set(declared)) {
      expect(keys).toContain(`logo_upload_${reason}`);
      expect(keys).toContain(`members_image_upload_${reason}`);
    }
  });
});
