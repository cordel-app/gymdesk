/**
 * #513: Add nif_nie_passport identification-document field to members.
 *
 * Nullable string — never numeric (leading zeros / alphanumeric passports
 * must be preserved). No uniqueness constraint (business rule not yet
 * confirmed by the ticket) and no index (nothing filters/searches on it
 * yet — see #515, a separate follow-up ticket, for that).
 */

exports.up = async (knex) => {
  const hasColumn = await knex.schema.hasColumn('members', 'nif_nie_passport');
  if (hasColumn) return;
  await knex.schema.alterTable('members', (t) => {
    t.string('nif_nie_passport', 20).nullable();
  });
};

exports.down = async (knex) => {
  const hasColumn = await knex.schema.hasColumn('members', 'nif_nie_passport');
  if (!hasColumn) return;
  await knex.schema.alterTable('members', (t) => {
    t.dropColumn('nif_nie_passport');
  });
};
