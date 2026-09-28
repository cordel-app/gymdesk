// #824: which step of a storage-backed save failed. Pure — no DB, no HTTP.
//
// The value crosses the wire and the admin interpolates it into a locale key
// (`storage_stage_<value>`), so the list here and the keys in
// `apps/admin/locales/base/*.json` have to stay in step — next-intl prints a
// missing key verbatim. `theme-upload-diagnostics.test.ts` asserts that half.

import { describe, expect, it } from 'vitest';
import { folderStageForKey, STORAGE_FAILURE_STAGES, themeFolderStageForKey } from '../domain/storageFailureStage';
import { themeLogoFolderKeys } from '../domain/themeLogo';
import { themeMemberFolderKeys } from '../domain/themeMemberImages';
import { themeStorageFolderKeys } from '../domain/themeFolders';

const PREFIX = 'gyms/123-QSport';

describe('STORAGE_FAILURE_STAGES', () => {
  it('names every step of a logo save, and each value only once', () => {
    expect(new Set(STORAGE_FAILURE_STAGES).size).toBe(STORAGE_FAILURE_STAGES.length);
    for (const stage of ['resolve_path', 'create_theme_folder', 'create_logo_folder', 'upload_logo', 'save_settings']) {
      expect(STORAGE_FAILURE_STAGES).toContain(stage);
    }
  });

  it('is a slug set — the admin builds a locale key out of each value', () => {
    for (const stage of STORAGE_FAILURE_STAGES) expect(stage).toMatch(/^[a-z][a-z_]*[a-z]$/);
  });
});

describe('folderStageForKey()', () => {
  const logoKeys = themeLogoFolderKeys(PREFIX, '456', 'Crimson Base');

  it('reports the leaf when the leaf marker is what failed', () => {
    expect(folderStageForKey(logoKeys[1], logoKeys, 'create_logo_folder')).toBe('create_logo_folder');
  });

  it("reports the theme folder when its own marker is what failed", () => {
    expect(folderStageForKey(logoKeys[0], logoKeys, 'create_logo_folder')).toBe('create_theme_folder');
  });

  it('falls back to the theme folder when the key is unknown or missing', () => {
    expect(folderStageForKey(null, logoKeys, 'create_logo_folder')).toBe('create_theme_folder');
    expect(folderStageForKey(undefined, logoKeys, 'create_logo_folder')).toBe('create_theme_folder');
    expect(folderStageForKey('gyms/other/', logoKeys, 'create_logo_folder')).toBe('create_theme_folder');
  });

  // A theme named "logo" has a folder of `…/themes/<id>-Logo/`, which a regex
  // on the key would read as the leaf. The list decides instead.
  it('is not fooled by a theme whose name is the leaf folder', () => {
    const keys = themeLogoFolderKeys(PREFIX, '9', 'logo');
    expect(keys[0]).toBe(`${PREFIX}/themes/9-logo/`);
    expect(folderStageForKey(keys[0], keys, 'create_logo_folder')).toBe('create_theme_folder');
    expect(folderStageForKey(keys[1], keys, 'create_logo_folder')).toBe('create_logo_folder');
  });

  it('works the same for the Members branch, whose leaf is one level deeper', () => {
    const keys = themeMemberFolderKeys(PREFIX, '456', 'Crimson Base');
    expect(folderStageForKey(keys[keys.length - 1], keys, 'create_members_folder')).toBe('create_members_folder');
    // The gym root and the gym-level `themes/` marker are not the theme's leaf.
    expect(folderStageForKey(keys[0], keys, 'create_members_folder')).toBe('create_theme_folder');
    expect(folderStageForKey(keys[1], keys, 'create_members_folder')).toBe('create_theme_folder');
  });
});

// #827: Theme creation writes three markers at once, so the stage comes from the
// position in `themeStorageFolderKeys()` rather than from a single leaf.
describe('themeFolderStageForKey (#827)', () => {
  const keys = themeStorageFolderKeys(PREFIX, '456', 'Crimson Base');

  it('names the marker that failed', () => {
    expect(themeFolderStageForKey(keys[0], keys)).toBe('create_theme_folder');
    expect(themeFolderStageForKey(keys[1], keys)).toBe('create_logo_folder');
    expect(themeFolderStageForKey(keys[2], keys)).toBe('create_members_folder');
  });

  it('falls back to the outermost stage when the key is unknown or missing', () => {
    expect(themeFolderStageForKey(null, keys)).toBe('create_theme_folder');
    expect(themeFolderStageForKey(undefined, keys)).toBe('create_theme_folder');
    expect(themeFolderStageForKey('gyms/other/themes/1-X/logo/', keys)).toBe('create_theme_folder');
  });

  it('reads the list rather than the key, so a theme named "logo" is not mistaken for its own leaf', () => {
    const named = themeStorageFolderKeys(PREFIX, '5', 'logo');
    expect(named[0]).toBe(`${PREFIX}/themes/5-logo/`);
    expect(themeFolderStageForKey(named[0], named)).toBe('create_theme_folder');
    expect(themeFolderStageForKey(named[1], named)).toBe('create_logo_folder');
  });
});
