/**
 * #2664: a Professional Service's Booking Type — `family_only` (participants of
 * one booking belong to the same family) or `open_group` (participants may come
 * from different families). Required, so NOT NULL; every existing service (Base
 * and gym-owned) takes the DEFAULT `open_group`, which restricts nobody, so no
 * booking behaves differently. Nothing reads it yet. Re-entrant.
 *
 * The accepted set is `SERVICE_BOOKING_TYPES` in `api/src/domain/serviceBookingType.ts`.
 */
const TABLE = 'professional_services';
const COLUMN = 'booking_type';
const CHECK = 'chk_professional_services_booking_type';

const hasColumn = async (knex) => {
  const [rows] = await knex.raw(
    `SELECT 1 FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`, [TABLE, COLUMN]);
  return rows.length > 0;
};

const hasCheck = async (knex) => {
  const [rows] = await knex.raw(
    `SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
      WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ? LIMIT 1`, [TABLE, CHECK]);
  return rows.length > 0;
};

exports.up = async (knex) => {
  if (!(await hasColumn(knex))) {
    await knex.raw(`ALTER TABLE ${TABLE} ADD COLUMN ${COLUMN} VARCHAR(20) NOT NULL DEFAULT 'open_group'`);
  }
  if (!(await hasCheck(knex))) {
    await knex.raw(`ALTER TABLE ${TABLE} ADD CONSTRAINT ${CHECK} CHECK (${COLUMN} IN ('family_only','open_group'))`);
  }
};

exports.down = async (knex) => {
  if (await hasCheck(knex)) await knex.raw(`ALTER TABLE ${TABLE} DROP CHECK ${CHECK}`);
  if (await hasColumn(knex)) await knex.raw(`ALTER TABLE ${TABLE} DROP COLUMN ${COLUMN}`);
};
