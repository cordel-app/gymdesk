/**
 * #1969 — an assigned Training Plan edited in place becomes a new version: Edit creates a
 * Draft copy linked to the plan it replaces. `draft_of_plan_id` is that link, set only
 * while the copy is a Draft and cleared when it is published. SET NULL so deleting the
 * original never deletes a draft. No CHECK (ALGORITHM=COPY).
 */

exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('training_plans', 'draft_of_plan_id'))) {
    await knex.raw('ALTER TABLE training_plans ADD COLUMN draft_of_plan_id INT UNSIGNED NULL');
    await knex.raw(
      'ALTER TABLE training_plans ADD CONSTRAINT fk_tp_draft_of FOREIGN KEY (draft_of_plan_id) REFERENCES training_plans (id) ON DELETE SET NULL',
    );
  }
};

exports.down = async (knex) => {
  if (await knex.schema.hasColumn('training_plans', 'draft_of_plan_id')) {
    await knex.raw('ALTER TABLE training_plans DROP FOREIGN KEY fk_tp_draft_of');
    await knex.raw('ALTER TABLE training_plans DROP COLUMN draft_of_plan_id');
  }
};
