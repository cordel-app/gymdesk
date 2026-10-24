/**
 * #1996 stage 1: execution history for the system jobs that kept none.
 *
 * `billing_run_log` and `recurring_booking_run_log` (migration 193) already
 * record `/billing/run` and `/recurring-bookings/run`. The other four job
 * endpoints — `/billing/cleanup`, `/promotion-lifecycle/run`,
 * `/plan-allowance-renewals/run` and `/booking-reminders/run` — had no
 * history, so they share this one table, one row per invocation, written
 * `in_progress` before the work and finalised on success or failure.
 *
 * Like the two run logs it has no `gym_id`: a system job is not tenant data.
 * `details` holds the job's own counters (the body it answers, never a request
 * body, header or credential); `error_summary` is a short, safe message.
 * `http_status` is the status the endpoint answered with and is not an exit
 * code. `status` is bounded by `chk_job_run_log_status`; `job` is a closed set
 * declared in `api/src/infra/job-run-log.ts` (no CHECK, so a new job needs no
 * ALTER of a table that grows every 15 minutes).
 */
exports.up = async function up(knex) {
  if (await knex.schema.hasTable('job_run_log')) return;
  await knex.raw(`
    CREATE TABLE job_run_log (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      job VARCHAR(40) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'in_progress',
      started_at DATETIME NOT NULL,
      finished_at DATETIME NULL,
      http_status SMALLINT UNSIGNED NULL,
      details JSON NULL,
      error_summary VARCHAR(255) NULL,
      CONSTRAINT chk_job_run_log_status CHECK (status IN ('in_progress','completed','failed','skipped')),
      INDEX job_run_log_job_started_index (job, started_at),
      INDEX job_run_log_started_index (started_at)
    )
  `);
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('job_run_log');
};
