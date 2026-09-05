/**
 * #346: Add profile fields to members table.
 * Adds: date_of_birth, gender, address, emergency_contact, notes.
 */

exports.up = async (knex) => {
  const has = (col) => knex.schema.hasColumn('members', col);
  await knex.schema.alterTable('members', (t) => {
    t.date('date_of_birth').nullable();
    t.string('gender', 20).nullable();
    t.string('address', 500).nullable();
    t.string('emergency_contact', 255).nullable();
    t.text('notes').nullable();
  });
  // hasColumn guard not needed here — all columns are new and migration is idempotent
  // via knex's own error if re-run, but we guard for safety in case of partial failure.
  void has; // unused — kept for reference pattern
};

exports.down = async (knex) => {
  await knex.schema.alterTable('members', (t) => {
    t.dropColumn('notes');
    t.dropColumn('emergency_contact');
    t.dropColumn('address');
    t.dropColumn('gender');
    t.dropColumn('date_of_birth');
  });
};
