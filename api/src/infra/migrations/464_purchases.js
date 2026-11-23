/**
 * #3251 stage 1 — a purchase is a cart.
 *
 * Until now "purchase id" meant one one-time Product line: `product_purchase_ids` (migration 413)
 * only handed those ids out, so the Product snapshots of two lines bought together, and the Product
 * Set they were bought with, had nothing in common. This migration:
 *
 *   1. renames `product_purchase_ids` to `product_line_ids`: it keeps allocating the id of a one-time
 *      line (`source_id`, what the `/product-purchases/:id` routes are keyed on) and nothing else;
 *   2. creates `purchases`, one row per cart, from the moment the cart is started: its owner (the
 *      member who buys), its status (`in_cart` → `pending_payment` → `completed`, or `cancelled`) and
 *      #1182's actor columns. `open_owner_key` (migration 213's generated-column device) is UNIQUE, so
 *      an owner has at most one cart `in_cart` at a time;
 *   3. adds `purchase_id` to `product_sets`, `product_session_snapshots` and `product_oneoff_snapshots`
 *      (nullable, FK ON DELETE SET NULL: a row that legitimately exists without a cart, such as a
 *      version the bridge creates for an edit, holds NULL; a cancelled cart is deleted by the
 *      application after the rows it created, `api/purchases.ts`);
 *   4. gives every open cart its purchase: each `in_cart` / `pending_payment` Product Set, the one-time
 *      lines linked to it, the owner's standalone `in_cart` lines (the owner's cart) and the standalone
 *      `pending_payment` lines of one Billing Event (one checkout). History (active, superseded,
 *      cancelled rows) keeps NULL: no purchase existed for it.
 *
 * `down` drops the columns and the table and renames the registry back.
 */

const LINE_ARMS = [
  { table: 'product_oneoff_snapshots', setJunction: 'product_set_oneoff_snapshots', eventJunction: 'billing_event_oneoff_snapshots', col: 'product_oneoff_snapshot_id' },
  { table: 'product_session_snapshots', setJunction: 'product_set_session_snapshots', eventJunction: 'billing_event_session_snapshots', col: 'product_session_snapshot_id' },
];

const rowsOf = (res) => res[0];

exports.up = async (knex) => {
  if (await knex.schema.hasTable('product_purchase_ids')) {
    await knex.raw('RENAME TABLE product_purchase_ids TO product_line_ids');
  }

  if (!(await knex.schema.hasTable('purchases'))) {
    await knex.raw(`
      CREATE TABLE purchases (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        gym_id CHAR(36) NOT NULL,
        owner_member_id INT UNSIGNED NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'in_cart',
        open_owner_key INT UNSIGNED GENERATED ALWAYS AS (IF(status = 'in_cart', owner_member_id, NULL)) VIRTUAL,
        created_at DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP()),
        created_by VARCHAR(255) NULL,
        modified_at DATETIME NULL,
        modified_by VARCHAR(255) NULL,
        PRIMARY KEY (id),
        UNIQUE KEY purchases_open_owner_key (open_owner_key),
        KEY idx_purchases_gym_owner (gym_id, owner_member_id),
        CONSTRAINT fk_purchases_gym FOREIGN KEY (gym_id) REFERENCES gyms (id) ON DELETE CASCADE,
        CONSTRAINT fk_purchases_owner FOREIGN KEY (owner_member_id) REFERENCES members (id) ON DELETE CASCADE,
        CONSTRAINT chk_purchases_status CHECK (status IN ('in_cart','pending_payment','completed','cancelled'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  }

  for (const table of ['product_sets', 'product_session_snapshots', 'product_oneoff_snapshots']) {
    if (await knex.schema.hasColumn(table, 'purchase_id')) continue;
    await knex.raw(`ALTER TABLE ${table} ADD COLUMN purchase_id INT UNSIGNED NULL,
      ADD KEY idx_${table}_purchase (purchase_id),
      ADD CONSTRAINT fk_${table}_purchase FOREIGN KEY (purchase_id) REFERENCES purchases (id) ON DELETE SET NULL`);
  }

  // 4a. Each open Product Set is a cart.
  const sets = rowsOf(await knex.raw(
    `SELECT id, gym_id, owner_member_id, status, created_by FROM product_sets
      WHERE status IN ('in_cart','pending_payment') AND purchase_id IS NULL ORDER BY id`));
  // The DDL above committed implicitly, so the backfill is not one transaction: each step reuses
  // what a partial earlier run left (a purchase it created and did not link) instead of adding one.
  for (const s of sets) {
    let [orphan] = rowsOf(await knex.raw(
      `SELECT p.id FROM purchases p
        WHERE p.gym_id = ? AND p.owner_member_id = ? AND p.status = ?
          AND NOT EXISTS (SELECT 1 FROM product_sets x WHERE x.purchase_id = p.id)
          AND NOT EXISTS (SELECT 1 FROM product_oneoff_snapshots x WHERE x.purchase_id = p.id)
          AND NOT EXISTS (SELECT 1 FROM product_session_snapshots x WHERE x.purchase_id = p.id)
        LIMIT 1`, [s.gym_id, s.owner_member_id, s.status]));
    if (!orphan) {
      const [ins] = await knex.raw(
        'INSERT INTO purchases (gym_id, owner_member_id, status, created_by) VALUES (?, ?, ?, ?)',
        [s.gym_id, s.owner_member_id, s.status, s.created_by ?? 'System']);
      orphan = { id: ins.insertId };
    }
    await knex.raw('UPDATE product_sets SET purchase_id = ? WHERE id = ?', [orphan.id, s.id]);
  }

  for (const arm of LINE_ARMS) {
    // 4b. A one-time line linked to a set is in the set's cart.
    await knex.raw(
      `UPDATE ${arm.table} s
         JOIN ${arm.setJunction} j ON j.${arm.col} = s.id
         JOIN product_sets ps ON ps.id = j.product_set_id
          SET s.purchase_id = ps.purchase_id
        WHERE s.purchase_id IS NULL AND ps.purchase_id IS NOT NULL AND s.source_id IS NOT NULL`);
    // 4c. A standalone line a set's checkout joined (#2949 stage 5) is in that set's cart.
    await knex.raw(
      `UPDATE ${arm.table} s
         JOIN ${arm.eventJunction} ej ON ej.${arm.col} = s.id
         JOIN billing_events be ON be.id = ej.billing_event_id
         JOIN product_sets ps ON ps.id = be.product_set_id
          SET s.purchase_id = ps.purchase_id
        WHERE s.purchase_id IS NULL AND ps.purchase_id IS NOT NULL AND s.source_id IS NOT NULL
          AND s.status = 'pending_payment'`);
  }

  // 4d. The owner's standalone lines still in the cart are the owner's cart.
  for (const arm of LINE_ARMS) {
    const lines = rowsOf(await knex.raw(
      `SELECT id, gym_id, member_id, created_by FROM ${arm.table}
        WHERE source_id IS NOT NULL AND purchase_id IS NULL AND status = 'in_cart' ORDER BY id`));
    for (const l of lines) {
      let [open] = rowsOf(await knex.raw(
        `SELECT id FROM purchases WHERE gym_id = ? AND owner_member_id = ? AND status = 'in_cart'`,
        [l.gym_id, l.member_id]));
      if (!open) {
        const [ins] = await knex.raw(
          `INSERT INTO purchases (gym_id, owner_member_id, status, created_by) VALUES (?, ?, 'in_cart', ?)`,
          [l.gym_id, l.member_id, l.created_by ?? 'System']);
        open = { id: ins.insertId };
      }
      await knex.raw(`UPDATE ${arm.table} SET purchase_id = ? WHERE id = ?`, [open.id, l.id]);
    }
  }

  // 4e. The standalone lines awaiting payment: one checkout per Billing Event.
  const byEvent = new Map();
  for (const arm of LINE_ARMS) {
    const lines = rowsOf(await knex.raw(
      `SELECT s.id, s.gym_id, s.member_id, s.created_by, MAX(ej.billing_event_id) AS event_id
         FROM ${arm.table} s LEFT JOIN ${arm.eventJunction} ej ON ej.${arm.col} = s.id
        WHERE s.source_id IS NOT NULL AND s.purchase_id IS NULL AND s.status = 'pending_payment'
        GROUP BY s.id, s.gym_id, s.member_id, s.created_by ORDER BY s.id`));
    for (const l of lines) {
      const key = l.event_id == null ? `line:${arm.table}:${l.id}` : `event:${l.event_id}`;
      let purchaseId = byEvent.get(key);
      if (purchaseId == null && l.event_id != null) {
        // A partial earlier run may already have given another line of this event its purchase.
        const [seen] = rowsOf(await knex.raw(
          `SELECT s.purchase_id FROM product_oneoff_snapshots s
             JOIN billing_event_oneoff_snapshots j ON j.product_oneoff_snapshot_id = s.id
            WHERE j.billing_event_id = ? AND s.purchase_id IS NOT NULL
           UNION ALL
           SELECT s.purchase_id FROM product_session_snapshots s
             JOIN billing_event_session_snapshots j ON j.product_session_snapshot_id = s.id
            WHERE j.billing_event_id = ? AND s.purchase_id IS NOT NULL
           LIMIT 1`, [l.event_id, l.event_id]));
        if (seen) purchaseId = seen.purchase_id;
      }
      if (purchaseId == null) {
        const [ins] = await knex.raw(
          `INSERT INTO purchases (gym_id, owner_member_id, status, created_by) VALUES (?, ?, 'pending_payment', ?)`,
          [l.gym_id, l.member_id, l.created_by ?? 'System']);
        purchaseId = ins.insertId;
        byEvent.set(key, purchaseId);
      }
      await knex.raw(`UPDATE ${arm.table} SET purchase_id = ? WHERE id = ?`, [purchaseId, l.id]);
    }
  }
};

exports.down = async (knex) => {
  for (const table of ['product_sets', 'product_session_snapshots', 'product_oneoff_snapshots']) {
    if (!(await knex.schema.hasColumn(table, 'purchase_id'))) continue;
    await knex.raw(`ALTER TABLE ${table} DROP FOREIGN KEY fk_${table}_purchase`);
    await knex.raw(`ALTER TABLE ${table} DROP KEY idx_${table}_purchase, DROP COLUMN purchase_id`);
  }
  await knex.raw('DROP TABLE IF EXISTS purchases');
  if (await knex.schema.hasTable('product_line_ids')) {
    await knex.raw('RENAME TABLE product_line_ids TO product_purchase_ids');
  }
};
