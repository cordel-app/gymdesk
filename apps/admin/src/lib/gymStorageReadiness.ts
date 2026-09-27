/**
 * #823: the one rule for "may this gym's admin upload an image right now?".
 *
 * Every per-gym upload writes into the gym's own R2 folder
 * (`gyms/<gym_id>-<gym_name>/…`), so two things have to be true before any
 * upload control is usable, and they fail for different reasons:
 *
 *  - **not_configured** — the *deployment* has no Cloudflare R2 credentials
 *    (`CLOUDFLARE_R2_*`); `GET /gyms/mine` reports that as
 *    `storage_configured: false` for every gym. Nobody can upload anything.
 *  - **not_initialized** — R2 is configured, but *this gym* has never had its
 *    bucket folder tree written, so it has no `storage_folder_prefix` to hang a
 *    key off. Gym Bucket Initialization is what writes that tree — including the
 *    gym-level `Themes/` root (#735) — and captures the prefix, so the prefix is
 *    also the only signal a client has that the gym's folders (the theme branch
 *    among them) exist at all. A theme's own
 *    `Themes/<theme_id>-<name>/Members/` branch is deliberately not part of it:
 *    it cannot exist before the theme does and `ensureStorageFolders()` writes it
 *    at upload time (#725).
 *
 * The API refuses both cases already (503 and 409 respectively — see
 * `resolveGymFolderPrefix()` in `api/src/api/gym-themes.ts`). This is the
 * frontend half: an upload control that is blocked says so and stays disabled,
 * rather than letting the admin pick a file and discover it afterwards.
 *
 * Pure and presentation-free on purpose — it is the same decision for a Theme
 * logo, a Members App background, an Exercise image or video and a plain
 * `ImageUploadField`, so there is one copy of it rather than one per control.
 */

/** Whichever of the two reasons blocks an upload, or `null` when nothing does. */
export type GymStorageBlock = 'not_configured' | 'not_initialized' | null;

/** The two fields of a gym this decision reads (`GymOption`, `GET /gyms/mine`). */
export interface GymStorageState {
  storage_configured: boolean;
  storage_folder_prefix: string | null;
}

/**
 * Why an upload into the given gym's folder is unavailable, or `null` when it is
 * available.
 *
 * @param gym The gym the upload would write into. `null`/`undefined` (the gym
 *   list has not loaded yet) answers `null`: a control is not declared blocked
 *   on the strength of a state nobody has read yet.
 * @param requiresGymStorage `false` for an upload that does **not** go into a
 *   gym's folder — a Base Exercise's or Base Theme's objects live under the
 *   platform root (`cordel/…`), which no gym's storage settings gate, so the
 *   superadmin's currently selected gym must not be able to block them.
 */
export function gymStorageBlock(
  gym: GymStorageState | null | undefined,
  requiresGymStorage = true,
): GymStorageBlock {
  if (!requiresGymStorage || gym == null) return null;
  if (!gym.storage_configured) return 'not_configured';
  if (!gym.storage_folder_prefix) return 'not_initialized';
  return null;
}
