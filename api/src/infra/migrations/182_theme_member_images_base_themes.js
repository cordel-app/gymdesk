/**
 * #732: a **Base Theme** carries the same six Members App background images a
 * Custom Theme has carried since #725 (migration 181).
 *
 * Only one thing stands in the way of reusing that table as it is: its `gym_id`
 * is `NOT NULL`, because when it was written a Base Theme had nowhere to put an
 * image — the platform owns no gym folder. #732 gives it one:
 *
 *     {bucket}/cordel/Themes/<theme_id>-<sanitized theme name>/Members/<slot>.png
 *
 * the platform-level sibling of the `gyms/` root (#668), so the only change the
 * schema needs is to let a row say "this image belongs to the platform, not to
 * a gym" — which is exactly what `themes.gym_id IS NULL` already says about the
 * theme itself. Widening the column keeps one table, one uniqueness rule
 * (`uq_theme_member_images (theme_id, slot)`) and one read path for both kinds
 * of theme; a parallel `base_theme_member_images` would have duplicated all
 * three for a difference of one nullable column.
 *
 * ── Why widening is safe ──────────────────────────────────────────────────
 *
 * `MODIFY COLUMN … NULL` on a `NOT NULL` column only relaxes what may be
 * written: every existing row already carries a gym id, so no row can fail the
 * new definition. MySQL still rebuilds the table for it (`ALGORITHM=INSTANT` is
 * refused for this change), which is why the statement pins
 * `ALGORITHM=INPLACE, LOCK=NONE`: the rebuild then happens online, and a server
 * that could not do it in place fails the migration loudly instead of silently
 * falling back to `COPY` and blocking writes for the duration. The column keeps
 * its type, its
 * charset and — crucially — its `utf8mb4_0900_ai_ci` collation, which must go
 * on being the collation of `gyms.id`, or `fk_theme_member_images_gym` would be
 * refused (migration 181 has the full note). The FK itself stays: a NULL child
 * column simply matches no parent row, which is what MySQL does with an
 * optional foreign key, so a platform row references no gym by construction
 * rather than by convention.
 *
 * `idx_theme_member_images_gym` is left alone. It indexes NULLs like any other
 * value, and the platform read (`gym_id IS NULL`) uses it.
 *
 * ── What still holds ──────────────────────────────────────────────────────
 *
 * The row — not the object — is what makes a slot configured (#725, #732 again:
 * *"The existence of the R2 object itself must not determine whether the image
 * is active"*), so Remove still deletes the row and leaves the object in the
 * bucket, for a Base Theme exactly as for a Custom one. The slot CHECK is
 * untouched and remains one of the two places the six slots are written down
 * (the other is `MEMBER_IMAGE_SLOTS` in `api/src/domain/themeMemberImages.ts`).
 *
 * Nothing is backfilled: no Base Theme Members image exists before this.
 */

exports.up = async (knex) => {
  if (!(await knex.schema.hasTable('theme_member_images'))) return;
  await knex.raw(`
    ALTER TABLE theme_member_images
      MODIFY COLUMN gym_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL,
      ALGORITHM=INPLACE, LOCK=NONE
  `);
};

exports.down = async (knex) => {
  if (!(await knex.schema.hasTable('theme_member_images'))) return;
  // Narrowing back would fail on any platform row written since `up()`, and a
  // Base Theme's images are not a gym's to adopt — so they are dropped, which
  // leaves their objects in the bucket under their deterministic keys exactly
  // as Remove does. Re-running `up()` and re-uploading lands on the same paths.
  //
  // The delete and the ALTER cannot be one transaction (DDL commits
  // implicitly), so a platform row inserted between them would fail the
  // narrowing and leave the column nullable with its rows already gone. The
  // loop makes that self-healing: delete again, narrow again. A re-run of a
  // half-finished rollback finishes it rather than compounding it.
  for (let attempt = 0; ; attempt += 1) {
    await knex('theme_member_images').whereNull('gym_id').del();
    try {
      await knex.raw(`
        ALTER TABLE theme_member_images
          MODIFY COLUMN gym_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
          ALGORITHM=INPLACE, LOCK=NONE
      `);
      return;
    } catch (err) {
      if (attempt >= 2) throw err;
    }
  }
};
