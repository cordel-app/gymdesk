/**
 * #2125 M5d-2 — a Product Set has no chain identity.
 *
 * Oscar's model (2026-11-03): a modification creates a new, independent Product
 * Set; the owner (`owner_member_id`) and the historical link to the set it
 * replaced (`previous_product_set_id`) are all that tie a member's Product Sets
 * together, and `root_product_set_id` is not to be kept. Since M5c-3 a billing
 * schedule is the owner's (`UNIQUE (owner_member_id, schedule_key)`), so the
 * root was left with two jobs, both taken over here:
 *
 *   1. `product_set_schedules.root_product_set_id` said which chain *opened* a
 *      schedule, which the two writers that may move a first Product Set's
 *      schedule (its start date, its cadence) and `ensureSchedule()`'s
 *      "same chain" test read. It becomes `opened_by_product_set_id`: the
 *      Product Set that opened the schedule, backfilled with the chain root
 *      (the only opener the old column recorded). The FK keeps the old
 *      `ON DELETE CASCADE`, so a discarded first Draft still takes the
 *      schedules it opened with it, but the column is nullable: nothing else
 *      depends on it, and the readers walk `previous_product_set_id` instead
 *      of comparing roots.
 *   2. `product_sets.root_product_set_id` grouped a chain's versions; every
 *      reader now asks the owner (one Active, one in-flight Product Set per
 *      owner) or walks `previous_product_set_id`. It is dropped with its FK
 *      and index.
 *
 * Nothing about money moves: no event, line, schedule anchor or key changes.
 *
 * `down` restores both columns: a Product Set's root is found by walking
 * `previous_product_set_id` to the set with none, and a schedule's root is its
 * opener's root (the owner's oldest Product Set when the opener is gone); a
 * schedule whose owner has no Product Set left is deleted. Each step is guarded.
 */
exports.up = async (knex) => {
  // 1. The schedule's opener.
  if (!(await knex.schema.hasColumn('product_set_schedules', 'opened_by_product_set_id'))) {
    await knex.raw(
      'ALTER TABLE product_set_schedules ADD COLUMN opened_by_product_set_id INT UNSIGNED NULL AFTER gym_id');
  }
  if (await knex.schema.hasColumn('product_set_schedules', 'root_product_set_id')) {
    await knex.raw(`
      UPDATE product_set_schedules SET opened_by_product_set_id = root_product_set_id
       WHERE opened_by_product_set_id IS NULL`);
  }
  if (!(await hasIndex(knex, 'product_set_schedules', 'pss_opened_by_index'))) {
    await knex.raw('ALTER TABLE product_set_schedules ADD KEY pss_opened_by_index (opened_by_product_set_id)');
  }
  if (!(await hasConstraint(knex, 'product_set_schedules', 'pss_opened_by_fk'))) {
    await knex.raw(`ALTER TABLE product_set_schedules
      ADD CONSTRAINT pss_opened_by_fk FOREIGN KEY (opened_by_product_set_id)
        REFERENCES product_sets (id) ON DELETE CASCADE`);
  }
  if (await hasConstraint(knex, 'product_set_schedules', 'pss_root_fk')) {
    await knex.raw('ALTER TABLE product_set_schedules DROP FOREIGN KEY pss_root_fk');
  }
  if (await hasIndex(knex, 'product_set_schedules', 'pss_root_index')) {
    await knex.raw('ALTER TABLE product_set_schedules DROP INDEX pss_root_index');
  }
  if (await knex.schema.hasColumn('product_set_schedules', 'root_product_set_id')) {
    await knex.raw('ALTER TABLE product_set_schedules DROP COLUMN root_product_set_id');
  }

  // 2. The Product Set's chain root.
  if (await hasConstraint(knex, 'product_sets', 'product_sets_root_fk')) {
    await knex.raw('ALTER TABLE product_sets DROP FOREIGN KEY product_sets_root_fk');
  }
  if (await hasIndex(knex, 'product_sets', 'product_sets_root_index')) {
    await knex.raw('ALTER TABLE product_sets DROP INDEX product_sets_root_index');
  }
  if (await knex.schema.hasColumn('product_sets', 'root_product_set_id')) {
    await knex.raw('ALTER TABLE product_sets DROP COLUMN root_product_set_id');
  }
};

async function hasIndex(knex, table, name) {
  const [rows] = await knex.raw(
    `SELECT 1 FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1`, [table, name]);
  return rows.length > 0;
}

async function hasConstraint(knex, table, name) {
  const [rows] = await knex.raw(
    `SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ? LIMIT 1`, [table, name]);
  return rows.length > 0;
}

exports.down = async (knex) => {
  // Each step is guarded on its own, so a rollback interrupted half-way can be run again.
  if (!(await knex.schema.hasColumn('product_sets', 'root_product_set_id'))) {
    await knex.raw('ALTER TABLE product_sets ADD COLUMN root_product_set_id INT UNSIGNED NULL AFTER owner_member_id');
  }
  await knex.raw(`
    UPDATE product_sets ps
      JOIN (
        WITH RECURSIVE walk (id, cur, prev) AS (
          SELECT id, id, previous_product_set_id FROM product_sets
          UNION ALL
          SELECT w.id, p.id, p.previous_product_set_id
            FROM walk w JOIN product_sets p ON p.id = w.prev
        )
        SELECT id, cur AS root FROM walk WHERE prev IS NULL
      ) r ON r.id = ps.id
       SET ps.root_product_set_id = r.root
     WHERE ps.root_product_set_id IS NULL`);
  if (!(await hasIndex(knex, 'product_sets', 'product_sets_root_index'))) {
    await knex.raw('ALTER TABLE product_sets ADD KEY product_sets_root_index (root_product_set_id)');
  }
  if (!(await hasConstraint(knex, 'product_sets', 'product_sets_root_fk'))) {
    await knex.raw(`ALTER TABLE product_sets
      ADD CONSTRAINT product_sets_root_fk FOREIGN KEY (root_product_set_id) REFERENCES product_sets (id) ON DELETE CASCADE`);
  }

  if (!(await knex.schema.hasColumn('product_set_schedules', 'root_product_set_id'))) {
    await knex.raw('ALTER TABLE product_set_schedules ADD COLUMN root_product_set_id INT UNSIGNED NULL AFTER gym_id');
  }
  if (await knex.schema.hasColumn('product_set_schedules', 'opened_by_product_set_id')) {
    await knex.raw(`
      UPDATE product_set_schedules pss
        LEFT JOIN product_sets op ON op.id = pss.opened_by_product_set_id
         SET pss.root_product_set_id = COALESCE(op.root_product_set_id,
               (SELECT MIN(p.id) FROM product_sets p WHERE p.owner_member_id = pss.owner_member_id))
       WHERE pss.root_product_set_id IS NULL`);
  }
  // A schedule whose owner has no Product Set left cannot be given a root: it is deleted (its events'
  // `schedule_id` goes NULL through their SET NULL FK) so the column can be NOT NULL again.
  await knex.raw('DELETE FROM product_set_schedules WHERE root_product_set_id IS NULL');
  await knex.raw('ALTER TABLE product_set_schedules MODIFY COLUMN root_product_set_id INT UNSIGNED NOT NULL');
  if (!(await hasIndex(knex, 'product_set_schedules', 'pss_root_index'))) {
    await knex.raw('ALTER TABLE product_set_schedules ADD KEY pss_root_index (root_product_set_id)');
  }
  if (!(await hasConstraint(knex, 'product_set_schedules', 'pss_root_fk'))) {
    await knex.raw(`ALTER TABLE product_set_schedules
      ADD CONSTRAINT pss_root_fk FOREIGN KEY (root_product_set_id) REFERENCES product_sets (id) ON DELETE CASCADE`);
  }
  if (await hasConstraint(knex, 'product_set_schedules', 'pss_opened_by_fk')) {
    await knex.raw('ALTER TABLE product_set_schedules DROP FOREIGN KEY pss_opened_by_fk');
  }
  if (await hasIndex(knex, 'product_set_schedules', 'pss_opened_by_index')) {
    await knex.raw('ALTER TABLE product_set_schedules DROP INDEX pss_opened_by_index');
  }
  if (await knex.schema.hasColumn('product_set_schedules', 'opened_by_product_set_id')) {
    await knex.raw('ALTER TABLE product_set_schedules DROP COLUMN opened_by_product_set_id');
  }
};
