/**
 * #2659 stage 2: the cancelled plans that still run to their last paid day
 * become `active_cancel_at_period_end`, the value the cancel paths now write.
 *
 * Moved: `cancelled` rows whose `ends_at` is today or later (UTC) — exactly the
 * rows `LIFECYCLE_STATUS_SQL` labelled *Cancels on End Date* until this stage,
 * so no label changes.
 *
 * Not moved: a replacement. Since #956 a Replace writes `superseded` (never
 * this status), but an older one wrote `cancelled` with `ends_at` set to the new
 * plan's `starts_at` ("the two plans meet at one date"); such a row is a
 * replacement, not a member's cancellation, and keeps `cancelled`. It is
 * recognised by another assignment of the same owner that starts on its
 * `ends_at` and was created after it.
 *
 * A relabel, not a lifecycle transition: the rows already read *Cancels on
 * End Date*, so no `status_change` audit row and no `modified_at`/`modified_by`
 * are written.
 *
 * Data only (no DDL). Idempotent: a moved row no longer matches. `down` puts
 * every `active_cancel_at_period_end` row back to `cancelled` (the value this
 * stage starts writing is indistinguishable from a moved one).
 */
exports.up = async (knex) => {
  // Selected first, then updated by id: MySQL refuses an UPDATE whose subquery
  // reads the table being updated (ER_UPDATE_TABLE_USED).
  const [rows] = await knex.raw(`
    SELECT um.id FROM user_memberships um
     WHERE um.status = 'cancelled'
       AND um.ends_at IS NOT NULL
       AND um.ends_at >= UTC_DATE()
       AND NOT EXISTS (
         SELECT 1 FROM user_memberships nxt
          WHERE nxt.gym_id = um.gym_id AND nxt.member_id = um.member_id AND nxt.id <> um.id
            AND nxt.status <> 'draft'
            AND DATE(nxt.starts_at) = DATE(um.ends_at)
            AND nxt.created_at >= um.created_at
       )`);
  const ids = rows.map((r) => r.id);
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    await knex.raw(
      `UPDATE user_memberships SET status = 'active_cancel_at_period_end'
        WHERE status = 'cancelled' AND id IN (${chunk.map(() => '?').join(',')})`,
      chunk,
    );
  }
};

exports.down = async (knex) => {
  await knex.raw(
    "UPDATE user_memberships SET status = 'cancelled' WHERE status = 'active_cancel_at_period_end'",
  );
};
