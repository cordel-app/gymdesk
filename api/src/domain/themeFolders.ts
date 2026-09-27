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

/**
 * `Logo` — the leaf of a theme's own folder that holds its logo (#824), and
 * `Members` — the leaf that holds its six Members App backgrounds (#725).
 *
 * Both live here rather than in `themeLogo.ts` / `themeMemberImages.ts` because
 * #827 creates the pair at Theme-creation time, before either of those features
 * is involved: the module that owns the parent folder owns the names of its
 * leaves, and the two upload modules re-export them so the strings still have
 * exactly one spelling.
 *
 * The case is load-bearing. R2 has no directories, so a marker written as
 * `logo/` would not rename `Logo/` — it would add a second folder beside the one
 * uploads actually write into, which is the defect #826 called out for the
 * gym-level tree.
 */
export const THEME_LOGO_FOLDER = 'Logo';
export const THEME_MEMBERS_FOLDER = 'Members';

/**
 * #827: the folder markers a Theme's storage initialization writes, outermost
 * first — the theme's own folder and both of its leaves:
 *
 * ```text
 * <folderPrefix>/Themes/<theme_id>-<sanitized name>/
 * <folderPrefix>/Themes/<theme_id>-<sanitized name>/Logo/
 * <folderPrefix>/Themes/<theme_id>-<sanitized name>/Members/
 * ```
 *
 * Deliberately **not** `<folderPrefix>/` or `<folderPrefix>/Themes/`: the gym
 * root and its `Themes/` branch belong to Gym Bucket Initialization (#735), and
 * #827 requires a Theme not to be created at all until that tree exists — so
 * this operation never papers over a missing one, exactly as
 * `themeLogoFolderKeys()` does not (#824).
 *
 * Idempotent by construction (§8): every key ends in `/`, so re-writing one
 * overwrites another zero-byte marker and can never touch a real object.
 *
 * The order is part of the contract — `themeFolderStageForKey()` reads it to
 * name the step that failed.
 */
export function themeStorageFolderKeys(folderPrefix: string, themeId: string, themeName: string): string[] {
  const themeFolder = buildThemeFolderPrefix(folderPrefix, themeId, themeName);
  return [`${themeFolder}/`, `${themeFolder}/${THEME_LOGO_FOLDER}/`, `${themeFolder}/${THEME_MEMBERS_FOLDER}/`];
}
