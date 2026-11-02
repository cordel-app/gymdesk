/**
 * #2125 stage 20 — a Draft remembers which plan it replaces.
 *
 * `POST /user-memberships/:id/assign-new-plan` creates a Draft successor of one plan. A member may
 * hold several plans now, so "replace" needs to say *which* one: `replaces_user_membership_id` is
 * that assignment (the plan whose row the action was raised from). Nullable, no backfill — every
 * existing row and every Draft created another way replaces whatever is in the way, as before.
 * `ON DELETE SET NULL`: if the replaced assignment's row is ever removed the Draft simply falls back
 * to that behaviour.
 */
exports.up = async (knex) => {
  if (await knex.schema.hasColumn('user_memberships', 'replaces_user_membership_id')) return;
  await knex.raw(`
    ALTER TABLE user_memberships
      ADD COLUMN replaces_user_membership_id INT UNSIGNED NULL,
      ADD KEY um_replaces_index (replaces_user_membership_id),
      ADD CONSTRAINT fk_um_replaces FOREIGN KEY (replaces_user_membership_id)
        REFERENCES user_memberships (id) ON DELETE SET NULL`);
};

exports.down = async (knex) => {
  if (!(await knex.schema.hasColumn('user_memberships', 'replaces_user_membership_id'))) return;
  await knex.raw(`
    ALTER TABLE user_memberships
      DROP FOREIGN KEY fk_um_replaces,
      DROP KEY um_replaces_index,
      DROP COLUMN replaces_user_membership_id`);
};
