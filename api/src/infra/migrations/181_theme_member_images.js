/**
 * #725: a Custom Theme carries the six Members App background images.
 *
 * Each image is an object in the gym's own Cloudflare R2 folder, under
 * `<gyms.storage_folder_prefix>/Themes/<theme_id>-<sanitized theme name>/Members/<slot>.png`,
 * and the row keeps only a reference to it — the same split #713 (migration
 * 180) made for the Custom Theme logo, for the same reason: the R2 endpoint
 * and bucket are deploy-time env vars, so the public URL is derived from the
 * key at read time (`buildStorageObjectUrl()`) rather than stored a second
 * time and left to go stale.
 *
 * ── Why a table and not six columns on `themes` ───────────────────────────
 *
 * The six slots are fixed (#725 is explicit that additional Members image
 * types are out of scope), so six `VARCHAR(512)` columns would work — but each
 * slot also needs its own "when was this last replaced" for the cache-busting
 * `?v=` the theme logo already uses, which is twelve columns for one feature
 * on a table every request for a gym already reads. One narrow row per
 * configured slot keeps `themes` the size it is, makes "configured" the
 * presence of a row (see below), and makes the uniqueness rule — one object
 * per (theme, slot) — a database constraint instead of a convention.
 *
 * ── The row is the source of truth, not the object ────────────────────────
 *
 * #725: *"The existence of the R2 object itself must not determine whether the
 * image is active"*, and *"Remove only clears the Theme URL/reference … Remove
 * does not delete the R2 object"*. So removing a slot deletes this row and
 * leaves the object where it is; re-uploading writes the same deterministic
 * key again and re-creates the row. That is the one place this feature
 * deliberately differs from the theme logo, which deletes its object on
 * remove.
 *
 * ── gym_id ────────────────────────────────────────────────────────────────
 *
 * Carried explicitly (CLAUDE.md: every domain table has one, every query
 * filters by it) even though it is reachable through `theme_id`, so the gym
 * filter never depends on a join. (Its `ON DELETE CASCADE` can never actually
 * fire — `fk_themes_gym` has none, so `themes` refuses the delete first — but
 * it costs nothing and states the ownership.) It is `NOT NULL`: a Base Theme
 * (`themes.gym_id IS NULL`) belongs to the platform and has no gym folder to
 * upload into, which is why #725 puts Base Theme Members images out of scope.
 * `uq_theme_member_images (theme_id, slot)` is what makes a slot a slot;
 * `ON DELETE CASCADE` from `themes` keeps a hard-deleted theme from leaving
 * rows behind (a soft delete leaves them, as it leaves the theme's tokens).
 *
 * `object_key` is `VARCHAR(512)`, sized like `themes.logo_object_key`, and the
 * slot list is a named CHECK in the same style as `chk_themes_created_by_type`
 * (migration 178) so an unknown slot cannot be written by any path. It is the
 * second of the two places the six slots are written down — the first is
 * `MEMBER_IMAGE_SLOTS` in `api/src/domain/themeMemberImages.ts`, and adding a
 * seventh to that one alone would upload the object and *then* fail the insert
 * (see CLAUDE.md). The CHECK is named so that future migration is a
 * `DROP CHECK` + `ADD CONSTRAINT` pair.
 *
 * Both timestamps default to `(UTC_TIMESTAMP())` — the house style since
 * migration 164 — rather than to `CURRENT_TIMESTAMP`, which is the server
 * session's clock: `timezone: 'Z'` in `infra/db.ts` marshals JS Dates and does
 * not set the server's `time_zone`, so on a deployment not running UTC the
 * default and the router's own `UTC_TIMESTAMP()` writes would disagree. For the
 * same reason `modified_at` carries no `ON UPDATE CURRENT_TIMESTAMP`: the
 * upload assigns it explicitly (it has to — a replacement writes the *same*
 * key, and MySQL skips a row whose assigned values all match, which would
 * freeze the `?v=` cache-buster the Members App reads), and an auto-bump could
 * only ever disagree with that.
 *
 * The two id columns carry explicit, *different* collations, as migration 065
 * had to: `gyms.id` is the schema default (`utf8mb4_0900_ai_ci`) while
 * `themes.id` is `utf8mb4_unicode_ci` (migration 056), and a foreign key whose
 * collation differs from its parent's is refused outright.
 *
 * Nothing is backfilled: no Members image exists anywhere before this.
 */

const SLOTS = ['training', 'nutrition', 'calendar', 'bookings', 'background', 'membership'];

exports.up = async (knex) => {
  if (!(await knex.schema.hasTable('theme_member_images'))) {
    await knex.raw(`
      CREATE TABLE theme_member_images (
        id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
        gym_id      CHAR(36)     CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
        theme_id    CHAR(36)     CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
        slot        VARCHAR(20)  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
        object_key  VARCHAR(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
        created_at  DATETIME     NOT NULL DEFAULT (UTC_TIMESTAMP()),
        modified_at DATETIME     NOT NULL DEFAULT (UTC_TIMESTAMP()),
        PRIMARY KEY (id),
        UNIQUE KEY uq_theme_member_images (theme_id, slot),
        KEY idx_theme_member_images_gym (gym_id),
        CONSTRAINT fk_theme_member_images_theme FOREIGN KEY (theme_id) REFERENCES themes(id) ON DELETE CASCADE,
        CONSTRAINT fk_theme_member_images_gym FOREIGN KEY (gym_id) REFERENCES gyms(id) ON DELETE CASCADE,
        CONSTRAINT chk_theme_member_images_slot CHECK (slot IN (${SLOTS.map((s) => `'${s}'`).join(',')}))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }
};

exports.down = async (knex) => {
  // Dropping the table drops the references, not the objects: every image
  // uploaded through this feature survives in the bucket under its
  // deterministic key, so re-running `up()` and re-uploading lands on the same
  // path. Nothing else reads these rows.
  if (await knex.schema.hasTable('theme_member_images')) {
    await knex.schema.dropTable('theme_member_images');
  }
};
