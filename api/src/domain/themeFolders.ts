// Where a theme's own folder lives inside the shared bucket (#725, #732, #824).
//
// Pure, and deliberately its own module: a theme's folder is the parent of both
// the Members backgrounds (`themeMemberImages.ts`) and the logo
// (`themeLogo.ts`), so neither of those may own it — the two would drift and a
// single theme would end up with two folders.

import { sanitizeStorageFolderName, THEMES_FOLDER } from '../infra/storage';

/**
 * `Themes` — the branch every theme's folder hangs off: the gym's folder for a
 * Custom Theme and `cordel/` for a Base Theme. The same folder Gym Bucket
 * Initialization creates as a top-level gym folder (#735), so it is defined
 * once in `infra/storage` and re-exported rather than spelled a second time.
 */
export const THEME_STORAGE_FOLDER = THEMES_FOLDER;

/**
 * `<folderPrefix>/Themes/<theme_id>-<sanitized theme name>` — the folder that
 * belongs to one theme. The id leads, so two themes of the same gym can share a
 * name (they cannot, but a renamed one can collide with a deleted one) without
 * ever sharing a folder, and `sanitizeStorageFolderName()` is the same
 * sanitizer the gym folder itself is built with, so one rule governs the whole
 * tree — which is why the folder reads `456-CrimsonBase` and not
 * `456-Crimson Base`: a key never carries a space.
 */
export function buildThemeFolderPrefix(folderPrefix: string, themeId: string, themeName: string): string {
  return `${folderPrefix}/${THEME_STORAGE_FOLDER}/${themeId}-${sanitizeStorageFolderName(themeName)}`;
}
