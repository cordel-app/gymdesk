// The step of a storage-backed save that failed (#824).
//
// A logo upload is not one call but a short pipeline — resolve the gym's
// folder, create the theme folder, create its `logo/` leaf, upload the file,
// save the theme row — and "Unauthorized" on its own says nothing about which
// of them broke. Every failure response from those routes therefore carries a
// `stage`, and the admin renders it as a line of the diagnostic.
//
// Pure and shared so the wire values have one definition. The admin interpolates
// each one into a locale key (`storage_stage_<value>`), so a new stage needs its
// key added in `apps/admin/locales/base/{en,es,ca}.json` as well — next-intl
// prints a missing key verbatim.

export const STORAGE_FAILURE_STAGES = [
  /** Reading the deployment's R2 config and the gym's `storage_folder_prefix`. */
  'resolve_path',
  /** Writing the `themes/<theme_id>-<name>/` folder marker. */
  'create_theme_folder',
  /** Writing the `logo/` folder marker inside the theme's folder. */
  'create_logo_folder',
  /** Writing the `members_app/` folder marker inside the theme's folder. */
  'create_members_folder',
  /** PUT of the logo object itself. */
  'upload_logo',
  /** DELETE of the logo object. */
  'remove_logo',
  /** PUT of a Members App background object. */
  'upload_members_image',
  /** DELETE of a Members App background object. */
  'remove_members_image',
  /** Server-side copy of the source theme's logo into a clone's folder (#1041). */
  'copy_logo',
  /** Server-side copy of one of the source theme's Members App backgrounds (#1041). */
  'copy_members_image',
  /** The `PUT /system/themes/:id` that saves name, description and tokens. */
  'save_settings',
] as const;

export type StorageFailureStage = (typeof STORAGE_FAILURE_STAGES)[number];

/**
 * Which folder marker `ensureStorageFolders()` was writing when it failed.
 *
 * The keys are the ones the caller passed, outermost first, so the last is the
 * leaf (`logo/` or `members_app/`) and anything before it is the theme's own
 * folder. Compared against that list rather than pattern-matched on the key: a
 * theme *named* "logo" has a folder called `…/themes/5-logo/`, and a regex on
 * the key would report creating it as the leaf.
 */
export function folderStageForKey(
  key: string | null | undefined,
  folderKeys: readonly string[],
  leafStage: StorageFailureStage,
): StorageFailureStage {
  return key && key === folderKeys[folderKeys.length - 1] ? leafStage : 'create_theme_folder';
}

/**
 * The stages of `themeStorageFolderKeys()`, in that function's order (#827).
 *
 * Index-aligned rather than pattern-matched for `folderStageForKey()`'s reason:
 * a theme *named* "logo" has a folder called `…/themes/5-logo/`, and a regex on
 * the key would report creating it as the leaf.
 */
const THEME_FOLDER_STAGES: readonly StorageFailureStage[] = [
  'create_theme_folder',
  'create_logo_folder',
  'create_members_folder',
];

/**
 * Which of a Theme's three initialization markers (#827) was being written when
 * `ensureStorageFolders()` failed — the theme's own folder, its `logo/` leaf or
 * its `members_app/` leaf.
 *
 * `folderKeys` are the keys the caller passed, i.e. exactly what
 * `themeStorageFolderKeys()` returned; anything else (a key from another
 * operation, or none at all) falls back to the outermost stage, which is the
 * step that must have been reached first.
 */
export function themeFolderStageForKey(
  key: string | null | undefined,
  folderKeys: readonly string[],
): StorageFailureStage {
  const index = key ? folderKeys.indexOf(key) : -1;
  return THEME_FOLDER_STAGES[index] ?? 'create_theme_folder';
}
