// #550 stage 1: Redistribute Promotion Benefits by Sellable Item Type and Frequency.
//
// Replaces the "quantity granted" half of Promotion Benefits (today's
// `promotion_included_benefits` + the quantity/frequency part of
// `promotion_period_benefits`) with three new tables keyed directly to real
// Sellable Items (`gym_charges`), sectioned by classification instead of the
// old `charge_types` pseudo-catalog (`is_gym_charge=0` rows like
// `nutrition_service`/`personal_training` were never real per-gym Sellable
// Items — see `classifySellableItem()` in
// `api/src/domain/sellableItemClassification.ts`):
//
//   - promotion_session     -> Sellable Item type = 'sessions'
//   - promotion_oneoff      -> type != 'sessions', non-recurring billing_frequency
//   - promotion_periodical  -> type != 'sessions', recurring billing_frequency
//     (the period/frequency is the Sellable Item's own `billing_frequency`,
//     read live via the FK join — not stored here, and not editable per-benefit)
//
// This is schema + classification helper only (stage 1 of the staged plan
// agreed on #550). The old `promotion_period_benefits` /
// `promotion_included_benefits` tables and their endpoints
// (`api/src/api/promotion-details.ts`) are left untouched for now so the app
// keeps working — API wiring, the hard cutover, and the "hard delete all
// promotions and start from scratch" data reset the ticket asked for all
// land together in stage 2, once the new tables are actually load-bearing.
// `promotion_charge_benefits` (discount-only, already keyed to
// `gym_charge_id` since migration 092) is a separate concern, untouched by
// this ticket.
//
// CREATE TABLE and ADD CONSTRAINT are separate non-transactional DDL
// statements, so the CHECK is guarded independently via information_schema
// (not folded into the same hasTable() check as table creation) — a crash
// between the two must not leave a re-run permanently skipping the CHECK
// (see migration 134/140 for precedent).

const TABLES = ['promotion_session', 'promotion_oneoff', 'promotion_periodical'];

exports.up = async (knex) => {
  for (const table of TABLES) {
    if (!(await knex.schema.hasTable(table))) {
      await knex.schema.createTable(table, (t) => {
        t.increments('id').primary();
        t.specificType('gym_id', 'char(36)').notNullable()
          .references('id').inTable('gyms').onDelete('CASCADE');
        t.integer('promotion_id').unsigned().notNullable()
          .references('id').inTable('promotions').onDelete('CASCADE');
        t.integer('gym_charge_id').unsigned().notNullable()
          .references('id').inTable('gym_charges').onDelete('CASCADE');
        t.integer('quantity').unsigned().notNullable().defaultTo(1);
        t.datetime('created_at').notNullable().defaultTo(knex.raw('(UTC_TIMESTAMP())'));
        t.integer('created_by_membership_id').unsigned().nullable()
          .references('id').inTable('gym_memberships').onDelete('SET NULL');

        t.unique(['promotion_id', 'gym_charge_id'], `${table}_promotion_charge_unique`);
        t.index(['gym_id'], `${table}_gym_id_index`);
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
  for (const table of TABLES) {
    await knex.schema.dropTableIfExists(table);
  }
};
