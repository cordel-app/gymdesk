/**
 * #2604 stage 1 (#2605 stage 2): a Professional Service session is also spent
 * when the booked event starts — the booking's reservation becomes the
 * consumption. The ledger's `reason` set gains `event_start`; nothing else
 * changes, and `psc_one_per_booking` still makes the spend idempotent.
 */
const REASONS = ['attendance', 'late_cancel', 'no_show', 'event_start'];

exports.up = async (knex) => {
  const list = REASONS.map((r) => `'${r}'`).join(', ');
  await knex.raw('ALTER TABLE professional_service_consumptions DROP CHECK chk_psc_reason');
  await knex.raw(
    `ALTER TABLE professional_service_consumptions ADD CONSTRAINT chk_psc_reason CHECK (reason IN (${list}))`,
  );
};

exports.down = async (knex) => {
  await knex.raw("DELETE FROM professional_service_consumptions WHERE reason = 'event_start'");
  await knex.raw('ALTER TABLE professional_service_consumptions DROP CHECK chk_psc_reason');
  await knex.raw(
    "ALTER TABLE professional_service_consumptions ADD CONSTRAINT chk_psc_reason CHECK (reason IN ('attendance','late_cancel','no_show'))",
  );
};
