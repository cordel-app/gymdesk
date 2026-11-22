/**
 * #3026 stage 3d-3d: `user_membership_promotions` and its three grant snapshot tables are dropped.
 *
 * Since stage 3d-1 a Membership Plan application is its plan snapshot's own row
 * (`plan_promotion_snapshots`), since 3d-3b/3d-3c a line-owned Product-target application is its
 * line's Product snapshot row (`product_promotion_snapshots`), and nothing reads or writes the legacy
 * table any more. Before the drop, whatever a reader could still reach is moved:
 *
 *   1. a line-owned Product-target legacy row that has no Product snapshot twin (by
 *      `source_application_id`) is written onto its line's snapshot (migration 348's backfill, with
 *      the owning set of migration 454 and the confirmation of migration 452);
 *   2. a Product-target legacy row owned by **no line** (none written since #1865) is attached to the
 *      set's only recurring line of a Product the Promotion grants, the default recorded on #3026.
 *      With none or several such lines it is reported and dropped with the table: a Product
 *      Promotion with nothing to apply to prices nothing;
 *   3. the grants each moved application froze are copied with it.
 *
 * Every insert is guarded by its source key, so a retry adds nothing. `billing_event_lines` keeps
 * its unused `promotion_application_id` column but loses the FK into the dropped table (nothing has
 * written that column since migration 261). The counts are logged.
 *
 * One-way: `down` refuses, as migration 415 does; the snapshot rows are the record.
 */
const PRODUCT_ROW = `EXISTS (SELECT 1 FROM promotions pr WHERE pr.id = ump.promotion_id AND pr.applies_to = 'product')`;

// The one recurring line of the application's set that holds a Product the Promotion grants, or NULL.
const ONLY_LINE = `(
  SELECT CASE WHEN COUNT(DISTINCT par.id) = 1 THEN MIN(par.id) END
    FROM product_set_periodical_snapshots j
    JOIN product_periodical_snapshots par ON par.id = j.product_periodical_snapshot_id
   WHERE j.product_set_id = ump.product_set_id
     AND par.product_id IN (
       SELECT product_id FROM promotion_session WHERE promotion_id = ump.promotion_id
       UNION SELECT product_id FROM promotion_oneoff WHERE promotion_id = ump.promotion_id
       UNION SELECT product_id FROM promotion_periodical WHERE promotion_id = ump.promotion_id))`;

const INSERT_COLUMNS = `(gym_id, member_id, product_periodical_snapshot_id, product_set_id, source_application_id,
   promotion_id, promotion_name, status, snapshot, applied_at, applied_by, consumed_at, revoked_at, created_at,
   created_by, modified_at, modified_by, snapshot_confirmed_at)`;

const SELECT_COLUMNS = `
  ump.gym_id, par.member_id, par.id, ump.product_set_id, ump.id, ump.promotion_id,
  JSON_UNQUOTE(JSON_EXTRACT(ump.snapshot, '$.name')), ump.status, ump.snapshot, ump.applied_at, ump.applied_by,
  ump.consumed_at, ump.revoked_at, ump.applied_at, ump.created_by, ump.modified_at, ump.modified_by,
  ump.snapshot_confirmed_at`;

const GRANTS = [
  ['session', 'user_membership_promotion_session_snapshot'],
  ['oneoff', 'user_membership_promotion_oneoff_snapshot'],
  ['periodical', 'user_membership_promotion_periodical_snapshot'],
];

async function scalar(knex, sql) {
  const [rows] = await knex.raw(sql);
  return Number(Object.values(rows[0])[0] ?? 0);
}

async function moveLegacyProductApplications(knex) {
  const counts = {};
  // 1. Line-owned rows with no Product snapshot twin.
  const [lined] = await knex.raw(`
    INSERT INTO product_promotion_snapshots ${INSERT_COLUMNS}
    SELECT ${SELECT_COLUMNS}
      FROM user_membership_promotions ump
      JOIN product_periodical_snapshots par ON par.source_id = ump.recurrent_snapshot_id AND par.gym_id = ump.gym_id
     WHERE ump.recurrent_snapshot_id IS NOT NULL AND ${PRODUCT_ROW}
       AND NOT EXISTS (SELECT 1 FROM product_promotion_snapshots x WHERE x.source_application_id = ump.id)`);
  counts.line_owned_moved = Number(lined.affectedRows ?? 0);

  // 2. Rows owned by no line, attached to the set's only line of a Product the Promotion grants.
  const [lineless] = await knex.raw(`
    INSERT INTO product_promotion_snapshots ${INSERT_COLUMNS}
    SELECT ${SELECT_COLUMNS}
      FROM user_membership_promotions ump
      JOIN product_periodical_snapshots par ON par.id = ${ONLY_LINE}
     WHERE ump.recurrent_snapshot_id IS NULL AND ump.product_set_id IS NOT NULL AND ${PRODUCT_ROW}
       AND NOT EXISTS (SELECT 1 FROM product_promotion_snapshots x WHERE x.source_application_id = ump.id)
       AND NOT EXISTS (SELECT 1 FROM product_promotion_snapshots q
                        WHERE q.product_periodical_snapshot_id = par.id AND q.product_set_id = ump.product_set_id
                          AND q.promotion_id = ump.promotion_id AND q.status = 'applied' AND ump.status = 'applied')`);
  counts.lineless_attached = Number(lineless.affectedRows ?? 0);

  // 3. The grants each moved application froze.
  counts.grants_moved = 0;
  for (const [kind, source] of GRANTS) {
    const [g] = await knex.raw(`
      INSERT INTO product_promotion_grant_snapshots
        (gym_id, product_promotion_snapshot_id, grant_kind, source_id, product_id, product_name, quantity,
         item_type, item_billing_frequency, unit_price, currency, action, value, requirement, created_at)
      SELECT g.gym_id, pp.id, '${kind}', g.id, g.product_id, g.product_name, g.quantity, g.item_type,
             g.item_billing_frequency, g.unit_price, g.currency, g.action, g.value, g.requirement, g.created_at
        FROM ${source} g
        JOIN product_promotion_snapshots pp
          ON pp.source_application_id = g.user_membership_promotion_id AND pp.gym_id = g.gym_id
       WHERE NOT EXISTS (SELECT 1 FROM product_promotion_grant_snapshots x
                          WHERE x.grant_kind = '${kind}' AND x.source_id = g.id)`);
    counts.grants_moved += Number(g.affectedRows ?? 0);
  }

  // What is dropped with the table without a twin a reader can reach.
  counts.dropped_unrepresented_product = await scalar(knex, `
    SELECT COUNT(*) FROM user_membership_promotions ump
     WHERE ${PRODUCT_ROW}
       AND NOT EXISTS (SELECT 1 FROM product_promotion_snapshots x WHERE x.source_application_id = ump.id)`);
  counts.dropped_unrepresented_plan = await scalar(knex, `
    SELECT COUNT(*) FROM user_membership_promotions ump
     WHERE NOT (${PRODUCT_ROW})
       AND NOT EXISTS (SELECT 1 FROM plan_promotion_snapshots x WHERE x.source_id = ump.id)`);
  return counts;
}

async function fkExists(knex, table, name) {
  const [rows] = await knex.raw(
    `SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ? AND CONSTRAINT_TYPE = 'FOREIGN KEY'`,
    [table, name]);
  return rows.length > 0;
}

exports.moveLegacyProductApplications = moveLegacyProductApplications;

exports.up = async (knex) => {
  if (await knex.schema.hasTable('user_membership_promotions')) {
    const counts = await moveLegacyProductApplications(knex);
    console.log(`[456] user_membership_promotions retired ${JSON.stringify(counts)}`);
  }
  if (await fkExists(knex, 'billing_event_lines', 'bel_promotion_fk')) {
    await knex.raw('ALTER TABLE billing_event_lines DROP FOREIGN KEY bel_promotion_fk');
  }
  for (const [, table] of GRANTS) await knex.schema.dropTableIfExists(table);
  await knex.schema.dropTableIfExists('user_membership_promotions');
};

exports.down = async () => {
  throw new Error('456 is one-way: user_membership_promotions is retired; its applications live on as plan and Product snapshot rows');
};
