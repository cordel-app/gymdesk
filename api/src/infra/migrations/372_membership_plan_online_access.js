/**
 * #2406: the On-line center. A Membership Plan in `specific_centers` mode may
 * also select the stable pseudo-center `online` (remote services). Stored as one
 * flag on the plan — not a `centers` row, which would be a "center" in every
 * physical-center query. Default 0 keeps every existing plan exactly as it was.
 * No CHECK (ALGORITHM=COPY). Re-entrant.
 */
const hasColumn = async (knex) => {
  const [rows] = await knex.raw(
    `SELECT 1 FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'membership_plans' AND COLUMN_NAME = 'online_access' LIMIT 1`);
  return rows.length > 0;
};

exports.up = async (knex) => {
  if (await hasColumn(knex)) return;
  await knex.raw('ALTER TABLE membership_plans ADD COLUMN online_access TINYINT(1) NOT NULL DEFAULT 0');
};

exports.down = async (knex) => {
  if (!(await hasColumn(knex))) return;
  await knex.raw('ALTER TABLE membership_plans DROP COLUMN online_access');
};
