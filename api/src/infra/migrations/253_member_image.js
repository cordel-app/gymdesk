/**
 * #1374 — a **Member carries a profile image**, the entry the gym tree in
 * `docs/cloudflare_structure.md` has listed since #1035 with no subject in the
 * code: `{gym prefix}/members/{member_id}-{member_name}.png`, 512 × 512.
 *
 * ── One column, the URL ─────────────────────────────────────────────────────
 *
 * `members.image_url` — the name and width every other media reference in this
 * schema has (`exercises` 187, `personal_goals` 225): the **URL**, not the key,
 * because `buildStorageObjectUrl()` / `storageKeyFromObjectUrl()` convert between
 * the two and a second convention would make "is this the same object?" answer
 * two ways. VARCHAR(1024) for migration 225's reason — the key carries a gym
 * folder prefix built from a VARCHAR(255) gym name plus the member's own name,
 * and the row is written *after* the object reaches R2, so an overflow would
 * leave an orphan and a 500 instead of a clean rejection; the key builder caps
 * the name part as well.
 *
 * `api/src/domain/memberImages.ts` is the one place the key is built and the
 * bytes are judged; `POST`/`DELETE /members/:id/image` are the only writers in
 * this ticket (the Member's own `/me` pair is #1375's).
 *
 * ── No CHECK, no backfill ───────────────────────────────────────────────────
 *
 * Any value is a URL this deployment built or NULL, and NULL is what every row
 * written before this migration means — "no image", rendered as the existing
 * placeholder on every surface. Nothing is generated or copied from anywhere
 * (#716's rule: no artwork is invented). `ADD CONSTRAINT` would also rebuild
 * `members` under `ALGORITHM=COPY` for nothing.
 *
 * `down()` drops the column, which forgets which object each member pointed at;
 * the objects stay in the bucket (a migration never deletes one), so a re-run
 * leaves every member with no image and the orphans behind — a sweep, not a
 * repair (`docs/go-to-production.md`).
 *
 * Guarded on its own statement: MySQL commits DDL implicitly, so a crash must
 * not make a re-run skip it (migrations 134/140/155/183/205/206/212/218/225).
 */

const TABLE = 'members';
const COLUMN = 'image_url';

exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn(TABLE, COLUMN))) {
    await knex.raw(`ALTER TABLE ${TABLE} ADD COLUMN ${COLUMN} VARCHAR(1024) NULL`);
  }
};

exports.down = async (knex) => {
  if (await knex.schema.hasColumn(TABLE, COLUMN)) {
    await knex.raw(`ALTER TABLE ${TABLE} DROP COLUMN ${COLUMN}`);
  }
};
