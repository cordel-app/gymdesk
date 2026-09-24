/**
 * #713: a Custom Theme logo lives in the gym's Cloudflare R2 folder.
 *
 * Until now every theme logo was a `themes.logo_bytes` MEDIUMBLOB (migration
 * 056) served by `GET /themes/:id/logo`. A gym already has an R2 folder tree
 * whose `Branding/Logo/` leaf exists for exactly this asset (#417 stage 1's
 * `initializeGymBucket()`), so a Customer Theme logo uploaded from now on is
 * stored there, under the fixed key `<storage_folder_prefix>/Branding/Logo/
 * logo.<ext>`, and the row keeps only a reference to it.
 *
 * `logo_object_key` is that reference — the one source of truth for where the
 * binary is. The public URL is *derived* from it at read time
 * (`buildStorageObjectUrl()` = endpoint + bucket + key, the same composition
 * `uploadGymImage()` has always returned) rather than stored a second time: the
 * R2 endpoint and bucket are deploy-time env vars, and a stored URL would go
 * stale the day either changes.
 *
 * Three deliberate non-changes:
 *
 *  - **`logo_bytes` stays.** Base Themes (`gym_id IS NULL`) belong to the
 *    platform and have no gym storage folder to upload into, so they remain
 *    blob-backed — #713 is explicit that Base Theme behaviour must not change.
 *  - **Nothing is backfilled.** A migration cannot upload to R2 (the SDK, the
 *    credentials and the per-gym folder all live in the API), and deleting a
 *    Customer Theme's existing `logo_bytes` would destroy the only copy of that
 *    logo. Customer logos uploaded before this migration therefore keep being
 *    served from the blob until someone uploads a replacement, which writes the
 *    R2 key and clears the blob in the same statement. Both readers
 *    (`GET /themes/:id/logo`, and `logo_url` on the theme-shaped responses)
 *    prefer the key and fall back to the blob, so the two states coexist
 *    without a flag day. See `docs/go-to-production.md`.
 *  - **`logo_mime` keeps its meaning** for both storage modes: it is the
 *    validated MIME of whatever is stored, and `has_logo` on every
 *    theme-shaped response is still derived from it. That is what keeps this
 *    migration invisible to `/me/gym`, `/gyms`, `/payment-page/token/:token`
 *    and both app headers.
 *
 * VARCHAR(512) is sized for `gyms/<uuid>-<sanitized gym name>/Branding/Logo/
 * logo.<ext>` with a lot of room to spare; it is nullable because a theme with
 * no logo, and a blob-backed one, both have no key.
 *
 * The key names the *gym*, not the theme (#713: one branding logo per gym,
 * `Branding/Logo/` its canonical location), while the column lives on `themes`
 * because that is what the API returns a logo on. A gym may hold several Custom
 * Themes, so `POST /system/themes/:id/logo` keeps the two consistent by handing
 * the branding slot over in one transaction: the uploading theme takes the key
 * and every other theme of the gym stops claiming a logo. Nothing else may write
 * this column — see `docs/architecture.md`.
 */

async function constraintExists(knex, name) {
  const [rows] = await knex.raw(
    `SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'themes'
       AND CONSTRAINT_TYPE = 'CHECK' AND CONSTRAINT_NAME = ?`,
    [name],
  );
  return rows.length > 0;
}

exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('themes', 'logo_object_key'))) {
    await knex.raw(
      'ALTER TABLE themes ADD COLUMN logo_object_key VARCHAR(512) NULL AFTER logo_bytes',
    );
  }

  // The two storage modes are mutually exclusive by construction — an upload
  // writes the key and clears the blob in one statement — and every reader
  // prefers the key. A row carrying both would serve R2 while hiding a stale
  // MEDIUMBLOB copy of a logo the gym believes it replaced, so the invariant is
  // enforced by the database and not only by the router. Named CHECK, same shape
  // as `chk_themes_created_by_type` (migration 178). Nothing is backfilled, so
  // no existing row can violate it.
  if (!(await constraintExists(knex, 'chk_themes_logo_storage'))) {
    await knex.raw(
      'ALTER TABLE themes ADD CONSTRAINT chk_themes_logo_storage ' +
      'CHECK (logo_bytes IS NULL OR logo_object_key IS NULL)',
    );
  }
};

exports.down = async (knex) => {
  if (await constraintExists(knex, 'chk_themes_logo_storage')) {
    await knex.raw('ALTER TABLE themes DROP CHECK chk_themes_logo_storage');
  }
  if (await knex.schema.hasColumn('themes', 'logo_object_key')) {
    // Rolling back is one-way for an R2-backed logo: the object survives in the
    // bucket but nothing can reach it once the key is gone. A row left with
    // `logo_mime` and no bytes would report `has_logo: true` and render as a
    // broken image in both app headers and on the checkout page, so those rows
    // are returned to "no logo" and fall back to the gym name instead.
    // `modified_at` is `ON UPDATE CURRENT_TIMESTAMP` (migration 056) — the
    // self-assignment suppresses the auto-bump, as migration 178 does.
    await knex.raw(
      `UPDATE themes SET logo_mime = NULL, logo_updated_at = NULL, modified_at = modified_at
       WHERE logo_object_key IS NOT NULL AND logo_bytes IS NULL`,
    );
    await knex.raw('ALTER TABLE themes DROP COLUMN logo_object_key');
  }
};
