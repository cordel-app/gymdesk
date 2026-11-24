/**
 * #3334: training_plan_templates.num_days — how many days the template covers,
 * an integer 0..7 (judged by parseNumDaysInput() in
 * src/domain/trainingPlanTemplateDays.ts, mirrored by chk_tpt_num_days).
 *
 * Existing templates are filled from their workouts: the number of distinct
 * weekdays they are scheduled on plus one per workout with no weekday, capped
 * at 7. Only rows still at the default are touched, so a re-run after a
 * partial failure completes the backfill without overwriting anything.
 */
const hasCheck = (knex) =>
  knex.raw(
    `SELECT COUNT(*) AS cnt FROM information_schema.TABLE_CONSTRAINTS
      WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'training_plan_templates'
        AND CONSTRAINT_NAME = 'chk_tpt_num_days'`,
  ).then(([rows]) => Number(rows[0].cnt) > 0);

exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('training_plan_templates', 'num_days'))) {
    await knex.raw(
      'ALTER TABLE training_plan_templates ADD COLUMN num_days TINYINT UNSIGNED NOT NULL DEFAULT 0',
    );
  }
  await knex.raw(
    `UPDATE training_plan_templates tpt
        SET tpt.num_days = (SELECT LEAST(7, COUNT(DISTINCT j.scheduled_weekday) + SUM(j.scheduled_weekday IS NULL))
                              FROM training_plan_template_workouts j
                             WHERE j.training_plan_template_id = tpt.id)
      WHERE tpt.num_days = 0
        AND EXISTS (SELECT 1 FROM training_plan_template_workouts j2 WHERE j2.training_plan_template_id = tpt.id)`,
  );
  if (!(await hasCheck(knex))) {
    await knex.raw(
      'ALTER TABLE training_plan_templates ADD CONSTRAINT chk_tpt_num_days CHECK (num_days BETWEEN 0 AND 7)',
    );
  }
};

exports.down = async (knex) => {
  if (await hasCheck(knex)) {
    await knex.raw('ALTER TABLE training_plan_templates DROP CHECK chk_tpt_num_days');
  }
  if (await knex.schema.hasColumn('training_plan_templates', 'num_days')) {
    await knex.raw('ALTER TABLE training_plan_templates DROP COLUMN num_days');
  }
};
