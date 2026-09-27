// #827: the folder markers a Theme's storage initialization writes, and which of
// them a failed `ensureStorageFolders()` was working on.
//
// Pure — no database, no HTTP, no R2. The router's own behaviour (the 409/503
// before the row is written, and the markers actually reaching R2) is covered by
// theme-storage-init.test.ts.

import { describe, expect, it } from 'vitest';
import {
  buildThemeFolderPrefix,
  THEME_LOGO_FOLDER,
  THEME_MEMBERS_FOLDER,
  themeStorageFolderKeys,
} from '../domain/themeFolders';
import { buildThemeLogoKey, themeLogoFolderKeys } from '../domain/themeLogo';
import { buildThemeMemberImageKey, themeMemberFolderKeys } from '../domain/themeMemberImages';

const PREFIX = 'gyms/11111111-QSport';
const THEME_ID = '456';

describe('themeStorageFolderKeys (#827)', () => {
  it('is the theme folder and its two leaves, outermost first', () => {
    expect(themeStorageFolderKeys(PREFIX, THEME_ID, 'Crimson Base')).toEqual([
      'gyms/11111111-QSport/Themes/456-CrimsonBase/',
      'gyms/11111111-QSport/Themes/456-CrimsonBase/Logo/',
      'gyms/11111111-QSport/Themes/456-CrimsonBase/Members/',
    ]);
  });

  it('creates neither the gym root nor its Themes/ branch — those are Gym Bucket Initialization (#735)', () => {
    const keys = themeStorageFolderKeys(PREFIX, THEME_ID, 'Crimson Base');
    expect(keys).not.toContain(`${PREFIX}/`);
    expect(keys).not.toContain(`${PREFIX}/Themes/`);
  });

  it('every key ends in a slash, which is what makes re-writing one idempotent (§8)', () => {
    for (const key of themeStorageFolderKeys(PREFIX, THEME_ID, 'Crimson Base')) {
      expect(key.endsWith('/')).toBe(true);
    }
  });

  it('hangs off the same folder the logo and Members uploads write into', () => {
    const folder = buildThemeFolderPrefix(PREFIX, THEME_ID, 'Crimson Base');
    const [themeFolder, logoFolder, membersFolder] = themeStorageFolderKeys(PREFIX, THEME_ID, 'Crimson Base');
    expect(themeFolder).toBe(`${folder}/`);

    // The point of initializing at creation time: the objects the two upload
    // features write later land *inside* these markers.
    expect(buildThemeLogoKey(PREFIX, THEME_ID, 'Crimson Base', 'image/png')).toBe(`${logoFolder}logo.png`);
    expect(buildThemeMemberImageKey(PREFIX, THEME_ID, 'Crimson Base', 'training')).toBe(`${membersFolder}training.png`);
  });

  it('agrees with the folders the two upload routes create on demand', () => {
    const keys = themeStorageFolderKeys(PREFIX, THEME_ID, 'Crimson Base');
    for (const key of themeLogoFolderKeys(PREFIX, THEME_ID, 'Crimson Base')) expect(keys).toContain(key);
    // `themeMemberFolderKeys()` also carries the gym root and its Themes/ branch,
    // which #827 deliberately does not create; the theme-scoped half must match.
    for (const key of themeMemberFolderKeys(PREFIX, THEME_ID, 'Crimson Base').slice(2)) {
      expect(keys).toContain(key);
    }
  });

  it('gives a clone its own folder — the source theme\'s path is never reused', () => {
    const source = themeStorageFolderKeys(PREFIX, '456', 'Crimson Base');
    const clone = themeStorageFolderKeys(PREFIX, '789', 'Crimson Base (copy)');
    for (const key of clone) expect(source).not.toContain(key);
  });

  it('keeps the leaf names in the case the uploads use — a lowercase marker would add a folder, not rename one', () => {
    expect(THEME_LOGO_FOLDER).toBe('Logo');
    expect(THEME_MEMBERS_FOLDER).toBe('Members');
  });

  it('works for a Base Theme under the platform root, which has no gym prefix', () => {
    expect(themeStorageFolderKeys('cordel', '3', 'Cordel Light')).toEqual([
      'cordel/Themes/3-CordelLight/',
      'cordel/Themes/3-CordelLight/Logo/',
      'cordel/Themes/3-CordelLight/Members/',
    ]);
  });
});
