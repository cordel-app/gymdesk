/**
 * #1158 — `next_bookings`, the eighth Members App image slot: the artwork of
 * the dashboard's **My Next Bookings** card.
 *
 * One CHECK swap and nothing else — migration 219's shape, for the same reason.
 * The slot list is written down in **two** places (CLAUDE.md):
 * `MEMBER_IMAGE_SLOTS` in `api/src/domain/themeMemberImages.ts` and
 * `chk_theme_member_images_slot` (created by migration 181, current definition
 * this one). Adding a slot to the list alone uploads the object to R2 and
 * *then* fails the insert, leaving an orphan and a 500 — which is the whole
 * reason this migration exists rather than the TypeScript change standing on
 * its own.
 *
 * The slot's name is also its file name (`members_app/next_bookings.png`,
 * `buildThemeMemberImageKey()`). The ticket asks for `bookings.png`, and that
 * name is **already taken**: `bookings` has been the My Bookings tile's slot
 * since migration 181, and its object key is `members_app/bookings.png`. A
 * second card stored under the same key would share the My Bookings tile's
 * artwork, which is exactly what the ticket's §6 forbids — so the stored value
 * is `next_bookings`, a name of its own, and never a label. Renaming it later
 * would strand every object uploaded under it (R2 has no directories; a key
 * already stored on a row is the only way back to its object).
 *
 * Nothing is backfilled and no existing row is touched: the seven slots keep
 * their keys, their rows and their behaviour, and a theme that configures
 * nothing for My Next Bookings simply has no row, which is what `null` — "not
 * configured" — has meant since #725.
 *
 * **Cost.** `DROP CHECK` is INPLACE/LOCK=NONE; `ADD CONSTRAINT … CHECK` is
 * neither, so MySQL rebuilds the table under ALGORITHM=COPY, LOCK=SHARED. The
 * table is `theme_member_images`: at most one narrow row per (theme, slot),
 * tens of rows per gym rather than a log, so the rebuild is milliseconds
 * rather than a maintenance window. The new list is a strict superset of the
 * old one, so revalidation cannot fail on existing data.
 *
 * The two helpers below are copied from migration 219 rather than shared. That
 * is deliberate, not drift: a migration is never edited, so a shared helper
 * would let a later change rewrite history that has already been applied.
 */

const SLOT_CHECK = 'chk_theme_member_images_slot';

/** Migration 219's seven, in that order, plus this migration's one. */
const SLOTS = ['training', 'nutrition', 'calendar', 'bookings', 'background', 'membership', 'personal_goals', 'next_bookings'];

/** The one value that tells this migration's list from migration 219's. */
const NEW_SLOT = 'next_bookings';

async function constraintExists(knex, table, name) {
  const [[row]] = await knex.raw(
    `SELECT COUNT(*) AS cnt FROM information_schema.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ?`,
    [table, name],
  );
  return row.cnt > 0;
}

/**
 * Does the live CHECK already list this value?
 *
 * MySQL renders `CHECK_CLAUSE` with charset introducers
 * (``(`slot` in (_utf8mb4'training',…))``), which is why this matches a
 * substring rather than comparing the clause. The `_` in `next_bookings` is a
 * single-character LIKE wildcard, so this really asks for `next` + any
 * character + `bookings`; the existing `bookings` value is not preceded by
 * `next`, so none of the seven existing slots matches, and the looseness is
 * kept for consistency with the migrations this is copied from.
 */
async function slotCheckAllows(knex, value) {
  const [[row]] = await knex.raw(
    `SELECT COUNT(*) AS cnt FROM information_schema.CHECK_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_NAME = ?
       AND CHECK_CLAUSE LIKE ?`,
    [SLOT_CHECK, `%${value}%`],
  );
  return row.cnt > 0;
}

/**
 * Swap the slot CHECK for the given list — but only when it is not already
 * right, so a re-run of `db:migrate` is a no-op rather than a second rebuild.
 *
 * The **existence** check is part of the guard rather than only of the DROP.
 * DDL commits implicitly, so a run that died between the DROP and the ADD comes
 * back to a table with no constraint at all, and a guard that only asked "does
 * the clause mention `next_bookings`" would read that as the narrow list it
 * wants and return without re-adding anything, leaving `slot` unconstrained for
 * good. Asking both questions is also what makes a database whose constraint
 * went missing repair itself on the next migrate.
 */
async function setSlotCheck(knex, slots) {
  const exists = await constraintExists(knex, 'theme_member_images', SLOT_CHECK);
  const allows = exists ? await slotCheckAllows(knex, NEW_SLOT) : false;
  if (exists && allows === slots.includes(NEW_SLOT)) return;
  if (exists) {
    await knex.raw(`ALTER TABLE theme_member_images DROP CHECK ${SLOT_CHECK}`);
  }
  const values = slots.map((s) => `'${s}'`).join(',');
  await knex.raw(
    `ALTER TABLE theme_member_images ADD CONSTRAINT ${SLOT_CHECK} CHECK (slot IN (${values}))`,
  );
}

exports.up = async (knex) => {
  // Deliberately unguarded on the table's existence, as migration 219 is:
  // knex's own ordering guarantees 181 created it, and a `hasTable` guard that
  // *returned* would be worse than no guard at all — knex would record 235 as
  // applied, `db:migrate` would never revisit it, and a database that later had
  // the table with the seven-slot CHECK would fail every `next_bookings` upload
  // (errno 3819, after the object is already in R2) permanently. A missing
  // table is a broken restore and should stop the migrate.
  await setSlotCheck(knex, SLOTS);
};

exports.down = async (knex) => {
  // Here a missing table genuinely means there is nothing to narrow.
  if (!(await knex.schema.hasTable('theme_member_images'))) return;
  // The rows have to go before the constraint narrows, or the ADD fails errno
  // 3819. Lossy by design, and the loss is a *reference*: the R2 object stays
  // where it is under its deterministic key (#725 — removing a slot has never
  // deleted an object), so re-running `up()` and re-uploading lands on the same
  // path. No batching: this table holds a handful of rows per gym, not a log —
  // though `slot` is not a left prefix of `uq_theme_member_images (theme_id,
  // slot)`, so this is a full scan, which is only acceptable at that size.
  //
  // Stop the API (or at least Members-image uploads) before rolling back, as
  // migration 219 asks for the same shape: DDL commits implicitly, so the
  // DELETE is committed by the DROP, and a `next_bookings` row inserted
  // between the two fails the ADD with errno 3819 and leaves `slot`
  // unconstrained. Re-running `down()` recovers — the existence half of the
  // guard re-adds a constraint that is missing rather than treating it as
  // already narrow, and the DELETE removes the offending row first.
  //
  // Note also that `npm run db:migrate:down` is `knex migrate:rollback`, which
  // reverts the whole *batch*, one migration at a time, newest first: if 234
  // and 235 landed in one deploy, this `down()` runs first and 234's follows —
  // and 234's refuses to narrow (it throws, touching nothing) while any
  // `user_memberships` row is `pending_payment`, so such a rollback stops
  // there with 235 already reverted and unrecorded. To step one migration:
  //   npx knex migrate:down --knexfile knexfile.cjs
  await knex.raw(`DELETE FROM theme_member_images WHERE slot = '${NEW_SLOT}'`);
  await setSlotCheck(knex, SLOTS.filter((s) => s !== NEW_SLOT));
};
