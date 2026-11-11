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
 *      from the root, then NOT NULL with an FK to `members` (CASCADE, as the
 *      root's own FK is);
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
 * `down` restores the chain key; it fails if a schedule had been shared by two
 * chains of one owner under one key since, which only the realign script does.
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
    const keep = (live.length > 0 ? live : rows)[(live.length > 0 ? live : rows).length - 1];
    for (const r of rows) {
      if (r.id === keep.id) continue;
      await knex.raw('UPDATE product_set_schedules SET schedule_key = ? WHERE id = ?',
        [`${r.schedule_key}-${r.id}`.slice(0, 40), r.id]);
    }
  }

  await knex.raw('ALTER TABLE product_set_schedules MODIFY COLUMN owner_member_id INT UNSIGNED NOT NULL');
  await knex.raw(`
    ALTER TABLE product_set_schedules
      ADD KEY pss_root_index (root_product_set_id),
      ADD UNIQUE KEY pss_owner_key (owner_member_id, schedule_key),
      ADD CONSTRAINT pss_owner_fk FOREIGN KEY (owner_member_id) REFERENCES members (id) ON DELETE CASCADE`);
  await knex.raw('ALTER TABLE product_set_schedules DROP INDEX pss_chain_key');
};

exports.down = async (knex) => {
  await knex.raw('ALTER TABLE product_set_schedules ADD UNIQUE KEY pss_chain_key (root_product_set_id, schedule_key)');
  await knex.raw(`
    ALTER TABLE product_set_schedules
      DROP FOREIGN KEY pss_owner_fk,
      DROP INDEX pss_owner_key,
      DROP INDEX pss_root_index`);
  await knex.raw('ALTER TABLE product_set_schedules DROP COLUMN owner_member_id');
};
