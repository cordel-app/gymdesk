/**
 * #3484 — Convert to Template on an Assigned Nutrition Plan.
 *
 * Converting writes a working copy of the plan as a gym template so the
 * template editor (whose sub-routes persist each change) can edit it; the copy
 * is not a created template until Save. `conversion_pending_at` marks it:
 * set by `POST /member-nutrition-plans/:id/convert-to-template`, cleared by
 * Save (`POST /nutrition-plan-templates/:id/conversion/complete`), and a row
 * still carrying it is the one row Cancel may hard-delete
 * (`DELETE /nutrition-plan-templates/:id/conversion`).
 *
 * A nullable column with no default: an INSTANT add, no rebuild; every
 * existing template is NULL (a created template).
 */
exports.up = async (knex) => {
  if (await knex.schema.hasColumn('nutrition_plan_templates', 'conversion_pending_at')) return;
  await knex.raw('ALTER TABLE nutrition_plan_templates ADD COLUMN conversion_pending_at DATETIME NULL');
};

exports.down = async (knex) => {
  if (!(await knex.schema.hasColumn('nutrition_plan_templates', 'conversion_pending_at'))) return;
  await knex.raw('ALTER TABLE nutrition_plan_templates DROP COLUMN conversion_pending_at');
};
