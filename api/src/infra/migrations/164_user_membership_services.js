/**
 * #631: Additional Periodic Services on an Assigned Plan.
 *
 * Recurring Sellable Items attached directly to a `user_memberships` row —
 * independent from the Membership Plan's included benefits and from Promotion
 * benefits (#631 §7). The Sellable Item's own `billing_frequency` and `amount`
 * stay the source of truth (no second product/service model, #631 §2), so only
 * the assignment-specific facts live here: which item, how many, and the
 * window it is billed for. `starts_at`/`ends_at` are `DATE`, matching the
 * parent `user_memberships` columns of the same name.
 *
 * `ends_at` is what makes removal future-only (#631 §3): removing a service
 * stamps the effective end date instead of deleting the row, so the Billing
 * Simulation keeps billing it from `starts_at` through `ends_at` and stops
 * afterwards, and no historical billing event is rewritten. A service whose
 * billing never started (`starts_at` in the future) is deleted outright by the
 * API — an `ends_at` before `starts_at` would violate chk_ums_ends_at.
 *
 * `gym_charge_id` deliberately has no ON DELETE CASCADE (same reasoning as
 * migration 130's user_membership_charge_benefits): gym_charges are only ever
 * soft-deleted, and an attached service must survive the item being retired.
 *
 * There is no unique constraint on (user_membership_id, gym_charge_id): the
 * same item may legitimately be attached twice over non-overlapping windows —
 * added, removed, added again later (#631 §3/§4). What must never happen is
 * two *open* attachments of the same item on the same assignment (they would
 * both bill), and that is exactly what the `open_service_key` generated column
 * below makes unique, so a double-submitted POST can't slip between the API's
 * overlap SELECT and its INSERT. The column is VIRTUAL, not STORED: MySQL
 * rejects STORED generated columns over FK columns (see migration 007, which
 * uses the same pattern for one active membership per member).
 *
 * CREATE TABLE and ADD CONSTRAINT are separate non-transactional DDL
 * statements, so each CHECK and the unique index are guarded independently via
 * information_schema — a crash between them must not leave a re-run
 * permanently skipping one (see migrations 134/140/155 for precedent).
 */

const TABLE = 'user_membership_services';

const CHECKS = {
  chk_ums_quantity: 'quantity > 0',
  chk_ums_ends_at: 'ends_at IS NULL OR ends_at >= starts_at',
};

async function constraintExists(knex, name) {
  const [[row]] = await knex.raw(
    `SELECT COUNT(*) AS cnt FROM information_schema.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ?`,
    [TABLE, name],
  );
  return row.cnt > 0;
}

exports.up = async (knex) => {
  if (!(await knex.schema.hasTable(TABLE))) {
    await knex.schema.createTable(TABLE, (t) => {
      t.increments('id').unsigned().primary();
      t.specificType('gym_id', 'char(36)').notNullable()
        .references('id').inTable('gyms').onDelete('CASCADE');
      t.integer('user_membership_id').unsigned().notNullable()
        .references('id').inTable('user_memberships').onDelete('CASCADE');
      t.integer('gym_charge_id').unsigned().notNullable()
        .references('id').inTable('gym_charges');
      t.integer('quantity').unsigned().notNullable().defaultTo(1);
      /** First date the service is billed — never earlier than the assignment's start. */
      t.date('starts_at').notNullable();
      /** Effective removal date; NULL while the service is still attached. */
      t.date('ends_at').nullable();
      t.datetime('created_at').notNullable().defaultTo(knex.raw('(UTC_TIMESTAMP())'));
      t.integer('created_by_membership_id').unsigned().nullable()
        .references('id').inTable('gym_memberships').onDelete('SET NULL');

      // Every read filters on both columns together; the leftmost prefix still
      // backs the gym_id foreign key.
      t.index(['gym_id', 'user_membership_id'], 'ums_gym_membership_index');
      t.index(['user_membership_id'], 'ums_membership_index');
    });
  }

  if (!(await knex.schema.hasColumn(TABLE, 'open_service_key'))) {
    await knex.raw(
      `ALTER TABLE ${TABLE} ADD COLUMN open_service_key VARCHAR(32) ` +
      "GENERATED ALWAYS AS (IF(ends_at IS NULL, CONCAT(user_membership_id, ':', gym_charge_id), NULL)) VIRTUAL",
    );
  }
  if (!(await constraintExists(knex, 'ums_one_open_per_item'))) {
    await knex.raw(`ALTER TABLE ${TABLE} ADD UNIQUE KEY ums_one_open_per_item (open_service_key)`);
  }

  for (const [name, expression] of Object.entries(CHECKS)) {
    if (!(await constraintExists(knex, name))) {
      await knex.raw(`ALTER TABLE ${TABLE} ADD CONSTRAINT ${name} CHECK (${expression})`);
    }
  }
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists(TABLE);
};
