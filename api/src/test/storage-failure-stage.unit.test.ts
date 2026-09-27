// #824: which step of a storage-backed save failed. Pure — no DB, no HTTP.
//
// The value crosses the wire and the admin interpolates it into a locale key
// (`storage_stage_<value>`), so the list here and the keys in
// `apps/admin/locales/base/*.json` have to stay in step — next-intl prints a
// missing key verbatim. `theme-upload-diagnostics.test.ts` asserts that half.

import { describe, expect, it } from 'vitest';
import { folderStageForKey, STORAGE_FAILURE_STAGES } from '../domain/storageFailureStage';
import { themeLogoFolderKeys } from '../domain/themeLogo';
import { themeMemberFolderKeys } from '../domain/themeMemberImages';

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

  // A theme named "Logo" has a folder of `…/Themes/<id>-Logo/`, which a regex
  // on the key would read as the leaf. The list decides instead.
  it('is not fooled by a theme whose name is the leaf folder', () => {
    const keys = themeLogoFolderKeys(PREFIX, '9', 'Logo');
    expect(keys[0]).toBe(`${PREFIX}/Themes/9-Logo/`);
    expect(folderStageForKey(keys[0], keys, 'create_logo_folder')).toBe('create_theme_folder');
    expect(folderStageForKey(keys[1], keys, 'create_logo_folder')).toBe('create_logo_folder');
  });

  it('works the same for the Members branch, whose leaf is one level deeper', () => {
    const keys = themeMemberFolderKeys(PREFIX, '456', 'Crimson Base');
    expect(folderStageForKey(keys[keys.length - 1], keys, 'create_members_folder')).toBe('create_members_folder');
    // The gym root and the gym-level `Themes/` marker are not the theme's leaf.
    expect(folderStageForKey(keys[0], keys, 'create_members_folder')).toBe('create_theme_folder');
    expect(folderStageForKey(keys[1], keys, 'create_members_folder')).toBe('create_theme_folder');
  });
});
