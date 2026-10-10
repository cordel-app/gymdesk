/**
 * #1325 PR 3d — `billing_events.user_membership_id` is dropped.
 *
 * Every money row belongs to a ProductSet since PR 3b (migration 254's
 * CHECK), and the assignment a ProductSet projects is `product_sets.
 * user_membership_id` (PR 3a). The column was the legacy link that PR 3b kept
 * writing beside `product_set_id` so the readers not yet moved could join the
 * assignment; those readers now answer through the chain
 * (`domain/billingEventOwnership.ts`), so the column is a second record of
 * one fact and goes.
 *
 * Nothing is read before the drop: a row's assignment is recoverable from its
 * `product_set_id`, and a row with none (a `product_purchase`, a
 * `card_verification` of a member with no set, the retired `status_changed`)
 * never had one worth keeping. The FK (`ON DELETE SET NULL`, migration 008)
 * and the two indexes over the column (008's single-column one and 150's
 * `(user_membership_id, created_at)`) go with it; every ALTER is guarded so a
 * partial run can be repeated.
 */
exports.up = async function up(knex) {
  const has = await knex.schema.hasColumn('billing_events', 'user_membership_id');
  if (!has) return;

  const [fks] = await knex.raw(
    `SELECT CONSTRAINT_NAME FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'billing_events'
        AND COLUMN_NAME = 'user_membership_id' AND REFERENCED_TABLE_NAME IS NOT NULL`,
  );
  for (const fk of fks) {
    await knex.raw(`ALTER TABLE billing_events DROP FOREIGN KEY \`${fk.CONSTRAINT_NAME}\``);
  }
  for (const name of ['billing_events_membership_created_index', 'billing_events_membership_index']) {
    const [idx] = await knex.raw('SHOW INDEX FROM billing_events WHERE Key_name = ?', [name]);
    if (idx.length > 0) await knex.raw(`ALTER TABLE billing_events DROP INDEX \`${name}\``);
  }
  await knex.raw('ALTER TABLE billing_events DROP COLUMN user_membership_id');
};

// The column comes back filled from the chain — the value it duplicated is
// still there (`domain/billingEventOwnership.ts`'s scalar), so a rollback is
// a real rollback; a row with no set has no assignment and stays NULL.
exports.down = async function down(knex) {
  const has = await knex.schema.hasColumn('billing_events', 'user_membership_id');
  if (has) return;
  await knex.schema.alterTable('billing_events', (t) => {
    t.integer('user_membership_id').unsigned().nullable().after('gym_id')
      .references('id').inTable('user_memberships').onDelete('SET NULL');
    t.index(['user_membership_id'], 'billing_events_membership_index');
    t.index(['user_membership_id', 'created_at'], 'billing_events_membership_created_index');
  });
  await knex.raw(
    `UPDATE billing_events be
        SET be.user_membership_id = (
          SELECT p2.user_membership_id FROM product_sets p1
            JOIN product_sets p2 ON p2.root_product_set_id = p1.root_product_set_id AND p2.gym_id = p1.gym_id
           WHERE p1.id = be.product_set_id AND p2.user_membership_id IS NOT NULL
           ORDER BY p2.version DESC, p2.id DESC LIMIT 1)
      WHERE be.product_set_id IS NOT NULL`,
  );
};
