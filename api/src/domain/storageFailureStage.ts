// The step of a storage-backed save that failed (#824).
//
// A logo upload is not one call but a short pipeline — resolve the gym's
// folder, create the theme folder, create its `Logo/` leaf, upload the file,
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
  /** Writing the `Themes/<theme_id>-<name>/` folder marker. */
  'create_theme_folder',
  /** Writing the `Logo/` folder marker inside the theme's folder. */
  'create_logo_folder',
  /** Writing the `Members/` folder marker inside the theme's folder. */
  'create_members_folder',
  /** PUT of the logo object itself. */
  'upload_logo',
  /** DELETE of the logo object. */
  'remove_logo',
  /** PUT of a Members App background object. */
  'upload_members_image',
  /** DELETE of a Members App background object. */
  'remove_members_image',
  /** The `PUT /system/themes/:id` that saves name, description and tokens. */
  'save_settings',
] as const;

export type StorageFailureStage = (typeof STORAGE_FAILURE_STAGES)[number];

/**
 * Which folder marker `ensureStorageFolders()` was writing when it failed.
 *
 * The keys are the ones the caller passed, outermost first, so the last is the
 * leaf (`Logo/` or `Members/`) and anything before it is the theme's own
 * folder. Compared against that list rather than pattern-matched on the key: a
 * theme *named* "Logo" has a folder called `…/Themes/5-Logo/`, and a regex on
 * the key would report creating it as the leaf.
 */
export function folderStageForKey(
  key: string | null | undefined,
  folderKeys: readonly string[],
  leafStage: StorageFailureStage,
): StorageFailureStage {
  return key && key === folderKeys[folderKeys.length - 1] ? leafStage : 'create_theme_folder';
}
