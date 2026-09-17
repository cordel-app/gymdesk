/**
 * #543: data repair for the Sellable Items "type_null" / blank-name bug.
 *
 * Migration 102 backfilled `name`/`type` on `gym_charges` once, from
 * `charge_types`, when those columns were added. It never updated the
 * runtime provisioning inserts in `api/src/api/gyms.ts` (POST /gyms and
 * POST /gyms/:id/duplicate), so every gym created or duplicated since
 * migration 102 shipped got its 6 charge-type-based system Sellable Items
 * seeded with `name`/`type` left NULL. Those code paths are fixed
 * alongside this migration; this repairs the rows already affected.
 *
 * Scoped to rows still missing name/type — never touches rows that already
 * have a value, so custom (non-charge_type) Sellable Items are untouched.
 */
exports.up = async (knex) => {
  await knex.raw(`
    UPDATE gym_charges gc
    JOIN charge_types ct ON ct.id = gc.charge_type_id
    SET gc.name = ct.name
    WHERE gc.name IS NULL
  `);

  await knex.raw(`
    UPDATE gym_charges
    SET type = 'fee'
    WHERE type IS NULL AND charge_type_id IS NOT NULL
  `);
};

exports.down = async () => {
  // Data repair only — the rows fixed here were NULL due to bug #543;
  // reverting would just reintroduce it. No schema change to undo.
};
