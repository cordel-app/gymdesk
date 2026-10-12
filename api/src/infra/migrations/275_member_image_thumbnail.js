/**
 * #1449 — a Member's profile image is a WebP **master and a WebP thumbnail**
 * (`{gym prefix}/members/{id}-{name}.webp`, 1080 × 1080, and `…-thumbnail.webp`,
 * 256 × 256, `docs/cloudflare_structure.md`). The master already has its column
 * (`members.image_url`, migration 253); this adds the thumbnail's, beside it.
 *
 * ── One more column, the URL ────────────────────────────────────────────────
 *
 * `members.image_thumbnail_url` is `exercises.image_thumbnail_url`'s shape
 * (migration 187): the **URL**, not the key, VARCHAR(1024) for migration 253's
 * reason, written in the same `UPDATE` as `image_url` and only after both
 * objects are in R2, so a member never points at a master with no thumbnail.
 *
 * ── No CHECK, no backfill ───────────────────────────────────────────────────
 *
 * NULL is what every row written before this migration means. The app has no
 * real members' photos yet (the ticket's own words), so nothing is converted:
 * an object already stored under a PNG key keeps rendering from its stored URL
 * and a row with no thumbnail reads as its master. `ADD CONSTRAINT` would also
 * rebuild `members` under `ALGORITHM=COPY` for nothing.
 *
 * `down()` drops the column; the objects stay in the bucket (a migration never
 * deletes one).
 *
 * Guarded on its own statement: MySQL commits DDL implicitly, so a crash must
 * not make a re-run skip it.
 */

const TABLE = 'members';
const COLUMN = 'image_thumbnail_url';

exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn(TABLE, COLUMN))) {
    await knex.raw(`ALTER TABLE ${TABLE} ADD COLUMN ${COLUMN} VARCHAR(1024) NULL AFTER image_url`);
  }
};

exports.down = async (knex) => {
  if (await knex.schema.hasColumn(TABLE, COLUMN)) {
    await knex.raw(`ALTER TABLE ${TABLE} DROP COLUMN ${COLUMN}`);
  }
};
