/**
 * #2125 M5c-3 — a billing schedule is the owner's, not the chain's.
 *
 * Oscar approved `(owner, periodicity)` as the schedule identity (2026-11-07,
 * 2026-11-11): a schedule must not depend on the Product Set lifecycle. Until
 * now `product_set_schedules` was keyed `(root_product_set_id, schedule_key)`,
 * so an owner who starts a new chain (possible only once their previous chain
 * has no Active and no in-flight version) opened new schedules beside the old
 * ones. This migration gives the schedule its owner:
 *
 *   1. `owner_member_id` (the member who owns the root Product Set), backfilled
 *      from the root, then NOT NULL with an FK to `members` (RESTRICT, as
 *      `product_sets_owner_fk` is: deleting a member never cascades into
 *      financial history);
 *   2. an owner holding the same key on two chains keeps it on the schedule of
 *      the chain that has an Active or in-flight version (else the newest
 *      schedule); every other one is re-keyed `<key>-<id>`. Nothing else moves:
 *      no event, line or anchor is touched, so this changes no money. Folding
 *      schedules of one identity across chains is `npm run schedules:realign`,
 *      which needs the engine and is therefore not a migration (M5c);
 *   3. `UNIQUE (owner_member_id, schedule_key)` replaces
 *      `UNIQUE (root_product_set_id, schedule_key)`. `root_product_set_id`
 *      stays, now meaning "the chain that opened the schedule" (its FK needs an
 *      index of its own once the composite key is gone); it goes with the other
 *      version columns.
 *
 * `down` restores the chain key and drops the column; it does not restore the
 * re-keyed `schedule_key` values (they still identify their schedule).
 */
exports.up = async (knex) => {
  const hasColumn = await knex.schema.hasColumn('product_set_schedules', 'owner_member_id');
  if (!hasColumn) {
    await knex.raw('ALTER TABLE product_set_schedules ADD COLUMN owner_member_id INT UNSIGNED NULL AFTER root_product_set_id');
  }
  await knex.raw(`
    UPDATE product_set_schedules pss
      JOIN product_sets ps ON ps.id = pss.root_product_set_id
       SET pss.owner_member_id = ps.owner_member_id
     WHERE pss.owner_member_id IS NULL`);

  const [dupes] = await knex.raw(`
    SELECT pss.id, pss.owner_member_id, pss.schedule_key,
           EXISTS (SELECT 1 FROM product_sets ps
                    WHERE ps.root_product_set_id = pss.root_product_set_id
                      AND ps.status IN ('active','pending_payment','draft')) AS live
      FROM product_set_schedules pss
      JOIN (SELECT owner_member_id, schedule_key FROM product_set_schedules
             GROUP BY owner_member_id, schedule_key HAVING COUNT(*) > 1) d
        ON d.owner_member_id = pss.owner_member_id AND d.schedule_key = pss.schedule_key
     ORDER BY pss.owner_member_id, pss.schedule_key, pss.id`);
  const groups = new Map();
  for (const r of dupes) {
    const k = `${r.owner_member_id}\u0000${r.schedule_key}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  for (const rows of groups.values()) {
    const live = rows.filter((r) => Number(r.live) === 1);
    const pool = live.length > 0 ? live : rows;
    const keep = pool[pool.length - 1];
    for (const r of rows) {
      if (r.id === keep.id) continue;
      // `<key>-<id>` is unique by its id; a key already ending in another id is
      // extended until the owner holds no such key.
      let next = `${r.schedule_key}-${r.id}`;
      for (;;) {
        const [taken] = await knex.raw(
          'SELECT 1 FROM product_set_schedules WHERE owner_member_id = ? AND schedule_key = ? LIMIT 1',
          [r.owner_member_id, next]);
        if (taken.length === 0) break;
        next = `${next}-${r.id}`;
      }
      if (next.length > 40) throw new Error(`schedule ${r.id}: re-keyed name '${next}' exceeds 40 characters`);
      await knex.raw('UPDATE product_set_schedules SET schedule_key = ? WHERE id = ?', [next, r.id]);
    }
  }
  const [left] = await knex.raw(`
    SELECT owner_member_id, schedule_key FROM product_set_schedules
     GROUP BY owner_member_id, schedule_key HAVING COUNT(*) > 1 LIMIT 1`);
  if (left.length > 0) throw new Error('product_set_schedules still holds a duplicate (owner_member_id, schedule_key)');

  await knex.raw('ALTER TABLE product_set_schedules MODIFY COLUMN owner_member_id INT UNSIGNED NOT NULL');
  // Each step is guarded, so a run interrupted half-way can be run again.
  if (!(await hasIndex(knex, 'pss_root_index'))) {
    await knex.raw('ALTER TABLE product_set_schedules ADD KEY pss_root_index (root_product_set_id)');
  }
  if (!(await hasIndex(knex, 'pss_owner_key'))) {
    await knex.raw('ALTER TABLE product_set_schedules ADD UNIQUE KEY pss_owner_key (owner_member_id, schedule_key)');
  }
  if (!(await hasConstraint(knex, 'pss_owner_fk'))) {
    await knex.raw(`ALTER TABLE product_set_schedules
      ADD CONSTRAINT pss_owner_fk FOREIGN KEY (owner_member_id) REFERENCES members (id) ON DELETE RESTRICT`);
  }
  if (await hasIndex(knex, 'pss_chain_key')) {
    await knex.raw('ALTER TABLE product_set_schedules DROP INDEX pss_chain_key');
  }
};

async function hasIndex(knex, name) {
  const [rows] = await knex.raw(
    `SELECT 1 FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'product_set_schedules' AND INDEX_NAME = ? LIMIT 1`, [name]);
  return rows.length > 0;
}

async function hasConstraint(knex, name) {
  const [rows] = await knex.raw(
    `SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'product_set_schedules' AND CONSTRAINT_NAME = ? LIMIT 1`, [name]);
  return rows.length > 0;
}

exports.down = async (knex) => {
  await knex.raw('ALTER TABLE product_set_schedules ADD UNIQUE KEY pss_chain_key (root_product_set_id, schedule_key)');
  await knex.raw(`
    ALTER TABLE product_set_schedules
      DROP FOREIGN KEY pss_owner_fk,
      DROP INDEX pss_owner_key,
      DROP INDEX pss_root_index`);
  await knex.raw('ALTER TABLE product_set_schedules DROP COLUMN owner_member_id');
};
