/**
 * #1970 — an assigned Nutrition Plan edited in place becomes a new version: Edit creates a
 * Draft copy linked to the plan it replaces. `draft_of_plan_id` is that link, set only while
 * the copy is a Draft and cleared when it is published (SET NULL, so deleting the original
 * never deletes a draft). `status` gains `draft`, and chk_mnp_status (migration 105) is widened
 * with it. Every reader that means "the member's plan" already filters on active/completed.
 */

exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('member_nutrition_plans', 'draft_of_plan_id'))) {
    await knex.raw('ALTER TABLE member_nutrition_plans ADD COLUMN draft_of_plan_id INT UNSIGNED NULL');
    await knex.raw(
      'ALTER TABLE member_nutrition_plans ADD CONSTRAINT fk_mnp_draft_of FOREIGN KEY (draft_of_plan_id) REFERENCES member_nutrition_plans (id) ON DELETE SET NULL',
    );
  }
  await knex.raw('ALTER TABLE member_nutrition_plans DROP CHECK chk_mnp_status').catch(() => {});
  await knex.raw(
    "ALTER TABLE member_nutrition_plans ADD CONSTRAINT chk_mnp_status CHECK (status IN ('active','completed','deleted','draft'))",
  );
};

exports.down = async (knex) => {
  await knex.raw("DELETE FROM member_nutrition_plans WHERE status = 'draft'");
  await knex.raw('ALTER TABLE member_nutrition_plans DROP CHECK chk_mnp_status').catch(() => {});
  await knex.raw(
    "ALTER TABLE member_nutrition_plans ADD CONSTRAINT chk_mnp_status CHECK (status IN ('active','completed','deleted'))",
  );
  if (await knex.schema.hasColumn('member_nutrition_plans', 'draft_of_plan_id')) {
    await knex.raw('ALTER TABLE member_nutrition_plans DROP FOREIGN KEY fk_mnp_draft_of');
    await knex.raw('ALTER TABLE member_nutrition_plans DROP COLUMN draft_of_plan_id');
  }
};
