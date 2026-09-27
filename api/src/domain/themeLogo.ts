// Where a theme's logo lives (#713, #824). Shared by every router that returns
// a theme-shaped response: `gym-themes.ts`, `gyms.ts` and `me.ts`.

import { buildStorageObjectUrl, extensionForMime } from '../infra/storage';
import { buildThemeFolderPrefix } from './themeFolders';

/**
 * `Logo` — the leaf folder of a theme's own folder that holds its logo (#824).
 * The sibling of `Members/`; both hang off `buildThemeFolderPrefix()`.
 */
export const THEME_LOGO_FOLDER = 'Logo';

/**
 * #824: the one key a theme's logo is stored under —
 * `<folderPrefix>/Themes/<theme_id>-<sanitized name>/Logo/logo.<ext>`.
 *
 * Theme-scoped, which is the whole of the change from #713's gym-wide
 * `Branding/Logo/logo.<ext>`: the key now names the *theme*, so every theme of
 * a gym may hold its own logo and uploading one no longer takes the slot away
 * from the others. The file name is still fixed and only the extension varies,
 * so replacing a logo with a different type still has to delete the key it
 * replaces — the extension comes from the server-validated MIME type, never
 * from the uploaded file's name, which reaches the key at no point.
 *
 * Rows written before #824 keep their `Branding/Logo/` key untouched (they are
 * read through the stored column, not rebuilt), and move here the next time the
 * logo is replaced.
 */
export function buildThemeLogoKey(
  folderPrefix: string,
  themeId: string,
  themeName: string,
  mime: string,
): string {
  const themeFolder = buildThemeFolderPrefix(folderPrefix, themeId, themeName);
  return `${themeFolder}/${THEME_LOGO_FOLDER}/logo.${extensionForMime(mime)}`;
}

/**
 * The folder markers a logo upload may create, outermost first: the theme's own
 * folder and its `Logo/` leaf.
 *
 * Deliberately **not** `<folderPrefix>/Themes/` — #824 requires the gym-level
 * `Themes/` root to exist already (Gym Bucket Initialization writes it, #735)
 * and the upload control to stay disabled until it does (#823), so this
 * operation never creates it. It never creates `Branding/` either: that folder
 * is obsolete.
 */
export function themeLogoFolderKeys(folderPrefix: string, themeId: string, themeName: string): string[] {
  const themeFolder = buildThemeFolderPrefix(folderPrefix, themeId, themeName);
  return [`${themeFolder}/`, `${themeFolder}/${THEME_LOGO_FOLDER}/`];
}

/**
 * #713: public URL of a theme logo stored in a gym's Cloudflare R2 folder, or
 * null when the row has no object key — a Base Theme, a Custom Theme whose logo
 * is still a `logo_bytes` blob (uploaded before migration 180), or a theme with
 * no logo at all. Those are served by `GET /themes/:id/logo`, which every
 * consumer keeps as its fallback.
 *
 * The key is deterministic for a given theme and type, so replacing a logo
 * reuses the same URL — hence the `?v=` stamp from `logo_updated_at`, the same
 * cache-buster the API logo route has always carried. R2 ignores the extra
 * query parameter.
 */
export function themeLogoUrl(
  row: { logo_object_key?: string | null; logo_updated_at?: Date | string | null },
): string | null {
  const url = buildStorageObjectUrl(row.logo_object_key);
  if (!url) return null;
  const updatedAt = row.logo_updated_at ? new Date(row.logo_updated_at).getTime() : NaN;
  return Number.isNaN(updatedAt) ? url : `${url}?v=${updatedAt}`;
}
