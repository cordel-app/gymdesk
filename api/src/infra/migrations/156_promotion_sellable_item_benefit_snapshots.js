// #550 stage 1 (continued): snapshot tables for the new Session/One-off/
// Periodical benefits (migration 155), so the system is ready for the next
// ticket that covers assigning a Membership Plan + Promotion to a member.
//
// Mirrors the existing `user_membership_promotions.snapshot` JSON approach
// (migration 149) in spirit — freeze what was granted at assignment time so
// later edits/deletes of the Promotion or the Sellable Item never change a
// member's already-applied benefits — but as real rows rather than JSON,
// keyed to the same `user_membership_promotion_id`. `gym_charge_name` is
// denormalized (copied at write time) so the snapshot still reads correctly
// even if the Sellable Item is later renamed or soft-deleted.
//
// Not yet written to or read anywhere — the assignment flow that populates
// these is out of scope for this ticket (per #550's clarification thread)
// and lands in a follow-up.
//
// FK/index names are explicit and short (not Knex's auto-generated
// <table>_<column>_<type>): these table names are long enough that the
// default names exceed MySQL's 64-char identifier limit and the CREATE/ALTER
// would fail outright on first run (see 153_sellable_item_professional_services.js
// for the same short-name convention).

const TABLES = [
  { table: 'user_membership_promotion_session_snapshot', prefix: 'ump_session_snap' },
  { table: 'user_membership_promotion_oneoff_snapshot', prefix: 'ump_oneoff_snap' },
  { table: 'user_membership_promotion_periodical_snapshot', prefix: 'ump_periodical_snap' },
];

exports.up = async (knex) => {
  for (const { table, prefix } of TABLES) {
    if (!(await knex.schema.hasTable(table))) {
      await knex.schema.createTable(table, (t) => {
        t.increments('id').primary();
        t.specificType('gym_id', 'char(36)').notNullable();
        t.foreign('gym_id', `${prefix}_gym_id_fk`)
          .references('id').inTable('gyms').onDelete('CASCADE');
        t.integer('user_membership_promotion_id').unsigned().notNullable();
        t.foreign('user_membership_promotion_id', `${prefix}_ump_id_fk`)
          .references('id').inTable('user_membership_promotions').onDelete('CASCADE');
        t.integer('gym_charge_id').unsigned().nullable();
        t.foreign('gym_charge_id', `${prefix}_gym_charge_id_fk`)
          .references('id').inTable('gym_charges').onDelete('SET NULL');
        t.string('gym_charge_name', 255).notNullable();
        t.integer('quantity').unsigned().notNullable();
        t.datetime('created_at').notNullable().defaultTo(knex.raw('(UTC_TIMESTAMP())'));

        t.index(['user_membership_promotion_id'], `${prefix}_ump_id_index`);
        t.index(['gym_id'], `${prefix}_gym_id_index`);
      });
    }

    // Checked independently of hasTable() above: CREATE TABLE and ADD CONSTRAINT are two
    // separate non-transactional DDL statements, so a crash between them must not leave a
    // re-run permanently skipping the CHECK constraint (see migration 134/140 for precedent).
    const constraintName = `chk_${table}_quantity`;
    const [[checkExists]] = await knex.raw(
      `SELECT COUNT(*) AS cnt FROM information_schema.TABLE_CONSTRAINTS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ?`,
      [table, constraintName],
    );
    if (checkExists.cnt === 0) {
      await knex.raw(
        `ALTER TABLE ${table} ADD CONSTRAINT ${constraintName} CHECK (quantity > 0)`,
      );
    }
  }
};

exports.down = async (knex) => {
  for (const { table } of TABLES) {
    await knex.schema.dropTableIfExists(table);
  }
};
