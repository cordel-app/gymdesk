/**
 * #1367 — Home dashboard: "Welcome new members" task.
 *
 * `members.welcomed_at` records when staff welcomed a Member. NULL means the
 * Member still needs a welcome. It is set by the explicit "Welcomed" checkbox
 * on the Members page (checked → now, unchecked → NULL) and nothing else.
 *
 * Every Member that exists when this runs is backfilled as already welcomed
 * (stamped with its own creation time): the task is about *new* members, and
 * leaving existing rows NULL would put the whole membership on the task list
 * on the first day. No CHECK or index — the column is a nullable timestamp and
 * the task filter is a per-gym scan of the Members list (ALGORITHM=COPY avoided).
 */

exports.up = async (knex) => {
  await knex.raw('ALTER TABLE members ADD COLUMN welcomed_at DATETIME NULL');
  await knex.raw('UPDATE members SET welcomed_at = COALESCE(created_at, UTC_TIMESTAMP()) WHERE welcomed_at IS NULL');
};

exports.down = async (knex) => {
  await knex.raw('ALTER TABLE members DROP COLUMN welcomed_at');
};
