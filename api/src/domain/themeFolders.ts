// Where a theme's own folder lives inside the shared bucket (#725, #732, #824).
//
// Pure, and deliberately its own module: a theme's folder is the parent of both
// the Members backgrounds (`themeMemberImages.ts`) and the logo
// (`themeLogo.ts`), so neither of those may own it — the two would drift and a
// single theme would end up with two folders.

import { sanitizeStorageFolderName, THEMES_FOLDER } from '../infra/storage';

/**
 * `themes` — the branch every theme's folder hangs off: the gym's folder for a
 * Custom Theme and `cordel/` for a Base Theme. The same folder Gym Bucket
 * Initialization creates as a top-level gym folder (#735), so it is defined
 * once in `infra/storage` and re-exported rather than spelled a second time.
 */
export const THEME_STORAGE_FOLDER = THEMES_FOLDER;

/**
 * `<folderPrefix>/themes/<theme_id>-<sanitized theme name>` — the folder that
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
 * `logo` — the leaf of a theme's own folder that holds its logo (#824), and
 * `members_app` — the leaf that holds its six Members App backgrounds (#725).
 *
 * Both live here rather than in `themeLogo.ts` / `themeMemberImages.ts` because
 * #827 creates the pair at Theme-creation time, before either of those features
 * is involved: the module that owns the parent folder owns the names of its
 * leaves, and the two upload modules re-export them so the strings still have
 * exactly one spelling.
 *
 * The exact strings are #829's (`logo/`, `members_app/`, under a lowercase
 * `themes/`), and they are load-bearing in both directions. R2 has no
 * directories, so the case *is* the folder: a marker written as `Logo/` beside
 * `logo/` adds a second folder rather than renaming one, which is the defect
 * #826 called out for the gym-level tree. And because a key already stored on a
 * row is the only way back to its object, nothing here rewrites one: the objects
 * an earlier deployment wrote under `Themes/…/Logo/` and `Themes/…/Members/`
 * keep rendering from their stored keys, move the next time the asset is
 * replaced, and are swept by hand (`docs/go-to-production.md`).
 */
export const THEME_LOGO_FOLDER = 'logo';
export const THEME_MEMBERS_FOLDER = 'members_app';

/**
 * `<folderPrefix>/` and `<folderPrefix>/themes/` — the two markers *above* a
 * theme's own folder.
 *
 * Who may write them depends on the root. A **gym's** pair belongs to Gym Bucket
 * Initialization (#735), and a gym-scoped upload must never create it: until it
 * exists the control is disabled (#823) and the route answers 409, which is what
 * makes an uninitialized gym reportable instead of papered over (#824). The
 * **platform** root has no such owner — `cordel/` is a constant, gated by no
 * gym's bucket — so the platform upload routes write it themselves, as
 * `themeMemberFolderKeys()` has done for a Base Theme's backgrounds since #732
 * and the Base Theme logo does since #829.
 */
export function themeRootFolderKeys(folderPrefix: string): string[] {
  return [`${folderPrefix}/`, `${folderPrefix}/${THEME_STORAGE_FOLDER}/`];
}

/**
 * #827: the folder markers a Theme's storage initialization writes, outermost
 * first — the theme's own folder and both of its leaves:
 *
 * ```text
 * <folderPrefix>/themes/<theme_id>-<sanitized name>/
 * <folderPrefix>/themes/<theme_id>-<sanitized name>/logo/
 * <folderPrefix>/themes/<theme_id>-<sanitized name>/members_app/
 * ```
 *
 * Deliberately **not** `<folderPrefix>/` or `<folderPrefix>/themes/`: the gym
 * root and its `themes/` branch belong to Gym Bucket Initialization (#735), and
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
