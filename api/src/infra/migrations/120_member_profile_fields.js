/**
 * #346: Add profile fields to members table.
 * Adds: date_of_birth, gender, address, emergency_contact, notes.
 */

exports.up = async (knex) => {
  const hasDateOfBirth      = await knex.schema.hasColumn('members', 'date_of_birth');
  const hasGender           = await knex.schema.hasColumn('members', 'gender');
  const hasAddress          = await knex.schema.hasColumn('members', 'address');
  const hasEmergencyContact = await knex.schema.hasColumn('members', 'emergency_contact');
  const hasNotes            = await knex.schema.hasColumn('members', 'notes');

  await knex.schema.alterTable('members', (t) => {
    if (!hasDateOfBirth)      t.date('date_of_birth').nullable();
    if (!hasGender)           t.string('gender', 20).nullable();
    if (!hasAddress)          t.string('address', 500).nullable();
    if (!hasEmergencyContact) t.string('emergency_contact', 255).nullable();
    if (!hasNotes)            t.string('notes', 3000).nullable();
  });
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
