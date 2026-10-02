/**
 * #947 — the Nutrition Library gains two more catalogues beside Foods:
 * **Personal Goals** (what the member wants to achieve) and **Nutrition Goals**
 * (what the plan should target nutritionally).
 *
 * ── Two tables, not one with a `kind` column ────────────────────────────────
 *
 * §8 of the ticket is explicit that the two are different concepts and must not
 * be mixed into a single list, "reflected in the UI *and* the data model". A
 * discriminator column is the shape that invites exactly the mixing it forbids
 * (one list, filtered), and the two are already on diverging paths: §9 has a
 * Nutrition Goal eventually carrying a target value ("150 g protein") that a
 * Personal Goal never will. So each concept gets its own table, with one shared
 * declaration in `api/src/domain/goalLibrary.ts` deciding what they have in
 * common — the kinds, their tables, their audit entity types and the seeded
 * System rows.
 *
 * ── Ownership is the Foods library's, unchanged ─────────────────────────────
 *
 * §5: "Do not create a different ownership model specifically for Goals". So
 * `gym_id` is nullable and means exactly what it means on
 * `nutrition_library_items` (migration 105): NULL = a **System** row, owned by
 * the platform and administered from Cordel, read-only to every gym; non-NULL =
 * that gym's own row. Soft delete is `status = 'deleted'` for the same reason —
 * it stays the flag every query filters on, with `deleted_at` recording *when*
 * (migration 196) — and the three actor pairs are snapshotted at write time
 * because a System row is written by a superadmin, who has no `gym_memberships`
 * row to join to (#799 §13).
 *
 * ── `slug` is the System row's label handle, and only a System row's ────────
 *
 * The seeded rows carry a stable slug so the admin can show them in Spanish and
 * Catalan through a `goal_library.<kind>_goal_<slug>` locale key that falls back
 * to the row's own `name` — the pattern CLAUDE.md already fixes for migration
 * 073's `result_types`, and the reason this ticket needs no per-locale junction
 * table (a gym's own goal is shown under the single name its staff typed, the
 * way a gym's own food is). `chk_<t>_slug_system_only` is what keeps it that
 * way: a gym row may never carry one, so a gym can never claim a System label
 * key. The slugs are deliberately the ones
 * the Nutrition Plan routers already validate a plan goal's `item_name` against
 * (the `NUTRITION_GOALS` list in `member-nutrition-plans.ts` and
 * `platform-nutrition-plan-templates.ts`), partitioned between the two concepts
 * — plus `fasting`, which §4 adds —
 * so a later ticket can link a plan's goal to its catalogue row without a
 * rename. Nothing reads them that way yet: assigning goals to plans or members
 * is out of scope, and this migration changes no existing table.
 *
 * ── Uniqueness is among *live* rows ─────────────────────────────────────────
 *
 * The routers refuse a duplicate name with `status != 'deleted'`, so a plain
 * UNIQUE(gym, name) would disagree with them: a goal the gym deleted would keep
 * its name reserved for ever, and re-adding it would surface as a 500 instead of
 * the 409 the router means. `<t>_live_name_key` is the migration-183 shape —
 * a VIRTUAL generated column that is non-NULL only while the row is live, with
 * the UNIQUE index on it — so the constraint and the router agree by
 * construction. VIRTUAL rather than STORED because MySQL rejects a STORED
 * generated column over a foreign-key column.
 *
 * Every statement is guarded on its own: MySQL commits DDL implicitly, so a
 * crash between two of them must not make a re-run skip one (migrations
 * 134/140/155/183/205).
 */

/**
 * Mirrors `GOAL_LIBRARY_TABLES` in `api/src/domain/goalLibrary.ts`; the value is the
 * prefix every constraint and index on that table is named with. `pgoal`/`ngoal`
 * rather than `pg`/`ng` because CHECK and FK names are schema-global in MySQL 8 and
 * a two-letter prefix is one a later table (`payment_gateways`, `nutrition_groups`)
 * could want too.
 */
const TABLES = {
  personal_goals: 'pgoal',
  nutrition_goals: 'ngoal',
};

/** Mirrors `GOAL_STATUSES` in `api/src/domain/goalLibrary.ts`. */
const STATUSES = ['active', 'deleted'];

/** Mirrors `SYSTEM_PERSONAL_GOALS` / `SYSTEM_NUTRITION_GOALS` in that module. */
const SEEDS = {
  personal_goals: [
    { slug: 'weight_loss', name: 'Weight Loss' },
    { slug: 'weight_gain', name: 'Weight Gain' },
    { slug: 'muscle_gain', name: 'Muscle Gain' },
    { slug: 'maintenance', name: 'Maintenance' },
    { slug: 'performance', name: 'Performance' },
    { slug: 'recovery', name: 'Recovery' },
    { slug: 'energy', name: 'Energy' },
  ],
  nutrition_goals: [
    { slug: 'calories', name: 'Calories' },
    { slug: 'protein', name: 'Protein' },
    { slug: 'carbohydrates', name: 'Carbohydrates' },
    { slug: 'fats', name: 'Fats' },
    { slug: 'fiber', name: 'Fiber' },
    { slug: 'water', name: 'Water' },
    { slug: 'fasting', name: 'Fasting' },
  ],
};

async function hasIndex(knex, table, name) {
  const [rows] = await knex.raw(
    `SELECT COUNT(*) AS cnt FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
    [table, name],
  );
  return Number(rows[0].cnt) > 0;
}

exports.up = async (knex) => {
  const statuses = STATUSES.map((s) => `'${s}'`).join(', ');

  for (const [table, prefix] of Object.entries(TABLES)) {
    if (!(await knex.schema.hasTable(table))) {
      await knex.raw(`
        CREATE TABLE ${table} (
          id               INT UNSIGNED  NOT NULL AUTO_INCREMENT,
          gym_id           CHAR(36)      NULL,
          slug             VARCHAR(50)   NULL,
          name             VARCHAR(255)  NOT NULL,
          description      VARCHAR(1000) NULL,
          status           VARCHAR(20)   NOT NULL DEFAULT 'active',
          created_at       DATETIME      NOT NULL DEFAULT (UTC_TIMESTAMP()),
          modified_at      DATETIME      NULL,
          deleted_at       DATETIME      NULL,
          created_by_name  VARCHAR(255)  NULL,
          created_by_type  VARCHAR(20)   NULL,
          modified_by_name VARCHAR(255)  NULL,
          modified_by_type VARCHAR(20)   NULL,
          deleted_by_name  VARCHAR(255)  NULL,
          deleted_by_type  VARCHAR(20)   NULL,
          live_name_key    VARCHAR(300)  GENERATED ALWAYS AS (
                             IF(status = 'deleted', NULL, CONCAT(COALESCE(gym_id, ''), ':', name))
                           ) VIRTUAL,
          PRIMARY KEY (id),
          UNIQUE KEY ${prefix}_slug_unique (slug),
          UNIQUE KEY ${prefix}_live_name_key (live_name_key),
          KEY ${prefix}_gym_status_index (gym_id, status),
          CONSTRAINT ${prefix}_gym_fk FOREIGN KEY (gym_id) REFERENCES gyms(id) ON DELETE CASCADE,
          CONSTRAINT chk_${prefix}_status CHECK (status IN (${statuses})),
          CONSTRAINT chk_${prefix}_slug_system_only CHECK (slug IS NULL OR gym_id IS NULL),
          CONSTRAINT chk_${prefix}_created_by_type
            CHECK (created_by_type IS NULL OR created_by_type IN ('staff','superadmin')),
          CONSTRAINT chk_${prefix}_modified_by_type
            CHECK (modified_by_type IS NULL OR modified_by_type IN ('staff','superadmin')),
          CONSTRAINT chk_${prefix}_deleted_by_type
            CHECK (deleted_by_type IS NULL OR deleted_by_type IN ('staff','superadmin'))
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
      `);
    }

    // Defensive, for a database where an earlier partial run left the table
    // without one of its unique indexes (the CREATE above is a single statement,
    // so this can only happen if someone built the table by hand). Both are
    // repaired, and before the seeding below, because the seed's own idempotence
    // is keyed on `slug`'s index.
    for (const index of [`${prefix}_slug_unique`, `${prefix}_live_name_key`]) {
      if (!(await hasIndex(knex, table, index))) {
        const column = index.endsWith('_slug_unique') ? 'slug' : 'live_name_key';
        await knex.raw(`CREATE UNIQUE INDEX ${index} ON ${table} (${column})`);
      }
    }

    // Seeded System rows (gym_id NULL), one INSERT per missing slug.
    //
    // The skip is keyed on the **slug's own presence** rather than on an
    // `INSERT IGNORE`: `IGNORE` downgrades every row-level error to a warning, so
    // a seed that failed for any other reason — a live-name collision with a
    // System goal an administrator created in the meantime, a CHECK violation, a
    // truncation — would leave the catalogue silently one row short while the
    // migration reported success, and a slug `SYSTEM_*_GOALS` claims exists would
    // have no row and no resolvable label. Only "this slug is already here" may
    // skip: an already-seeded row, one Cordel has renamed, one soft-deleted.
    //
    // Re-runnable for crash recovery *within this migration*, not a place to edit
    // the catalogue: knex never re-runs a migration it has recorded, so an eighth
    // System goal is a new migration plus a line in `SYSTEM_*_GOALS`, never a line
    // in `SEEDS` here.
    const [existing] = await knex.raw(`SELECT slug FROM ${table} WHERE slug IS NOT NULL`);
    const present = new Set(existing.map((row) => row.slug));
    for (const seed of SEEDS[table]) {
      if (present.has(seed.slug)) continue;
      await knex.raw(
        `INSERT INTO ${table} (gym_id, slug, name, created_by_name, created_by_type)
         VALUES (NULL, ?, ?, 'Cordel', 'superadmin')`,
        [seed.slug, seed.name],
      );
    }
  }
};

exports.down = async (knex) => {
  // Nothing references these tables yet (assigning a goal to a plan or a member
  // is out of scope for #947), so dropping them loses only the gym-created rows
  // — which is what a `down` of a catalogue-creating migration means.
  for (const table of Object.keys(TABLES)) {
    await knex.schema.dropTableIfExists(table);
  }
};

exports.TABLES = TABLES;
exports.STATUSES = STATUSES;
exports.SEEDS = SEEDS;
