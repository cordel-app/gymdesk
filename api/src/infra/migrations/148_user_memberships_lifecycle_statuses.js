/**
 * #511 (stage 1): Assigned Plans lifecycle — add the `draft` and
 * `awaiting_payment` statuses used by the new submit/close/pause/reactivate
 * transitions (see api/src/api/user-memberships.ts), plus `closed_at` to
 * record when a Close transition happened independently of `ends_at` (which
 * already carries an unrelated, admin-settable planned/actual end date).
 *
 * The ticket's "Closed" action maps onto the existing `cancelled` value —
 * no new terminal status is introduced for it.
 */
exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('user_memberships', 'closed_at'))) {
    await knex.schema.alterTable('user_memberships', (t) => {
      t.dateTime('closed_at').nullable();
    });
  }

  await knex.raw('ALTER TABLE user_memberships DROP CHECK user_memberships_status_check').catch(() => {});
  await knex.raw(
    "ALTER TABLE user_memberships ADD CONSTRAINT user_memberships_status_check " +
    "CHECK (status IN ('draft','awaiting_payment','active','paused','cancelled','expired'))",
  );
};

exports.down = async (knex) => {
  // Lossy rollback (mirrors 125_membership_plans_enrollment_status_no_closed.js):
  // MySQL validates existing rows when a CHECK is added, so once any
  // draft/awaiting_payment row exists this will fail to re-add the narrower
  // 4-value constraint and silently no-op rather than error.
  await knex.raw('ALTER TABLE user_memberships DROP CHECK user_memberships_status_check').catch(() => {});
  await knex.raw(
    "ALTER TABLE user_memberships ADD CONSTRAINT user_memberships_status_check " +
    "CHECK (status IN ('active','paused','cancelled','expired'))",
  ).catch(() => {});

  if (await knex.schema.hasColumn('user_memberships', 'closed_at')) {
    await knex.schema.alterTable('user_memberships', (t) => t.dropColumn('closed_at'));
  }
};
