/**
 * #67: training_plans becomes the authoritative record for the personalized-
 * plan lifecycle shown in the new Training Plans module. Adds start_date
 * (backfilled from the plan's assignment row's valid_from, falling back to
 * the creation date) and end_date (stamped when a plan is expired by the
 * assign-new-plan flow), and replaces the status vocabulary:
 * active/inactive/deleted -> draft/active/expired/deleted (existing
 * 'inactive' rows map to 'expired' per ticket clarification).
 * member_training_plans stays as append-only assignment history.
 */
exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('training_plans', 'start_date'))) {
    await knex.schema.alterTable('training_plans', (t) => {
      t.date('start_date');
      t.date('end_date');
    });
    await knex.raw(`
      UPDATE training_plans tp
      LEFT JOIN (
        SELECT training_plan_id, MAX(id) AS mtp_id
        FROM member_training_plans GROUP BY training_plan_id
      ) latest ON latest.training_plan_id = tp.id
      LEFT JOIN member_training_plans mtp ON mtp.id = latest.mtp_id
      SET tp.start_date = COALESCE(mtp.valid_from, DATE(tp.created_at)),
          tp.end_date = mtp.valid_to
    `);
    await knex.raw('ALTER TABLE training_plans MODIFY start_date date NOT NULL');
  }

  await knex.raw('ALTER TABLE training_plans DROP CHECK training_plans_status_check').catch(() => {});
  await knex.raw("UPDATE training_plans SET status = 'expired' WHERE status = 'inactive'");
  await knex.raw(
    "ALTER TABLE training_plans ADD CONSTRAINT training_plans_status_check " +
    "CHECK (status IN ('draft','active','expired','deleted'))",
  );
};

exports.down = async (knex) => {
  await knex.raw('ALTER TABLE training_plans DROP CHECK training_plans_status_check').catch(() => {});
  await knex.raw("UPDATE training_plans SET status = 'inactive' WHERE status IN ('draft','expired')");
  await knex.raw(
    "ALTER TABLE training_plans ADD CONSTRAINT training_plans_status_check " +
    "CHECK (status IN ('active','inactive','deleted'))",
  );
  if (await knex.schema.hasColumn('training_plans', 'start_date')) {
    await knex.schema.alterTable('training_plans', (t) => {
      t.dropColumn('start_date');
      t.dropColumn('end_date');
    });
  }
};
