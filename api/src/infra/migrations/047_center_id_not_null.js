/**
 * #59: enforce center_id NOT NULL on rooms/class_sessions/bookings, now
 * that 046 has backfilled every row. Split into its own file so a partial
 * failure in 046's backfill loop never leaves a table half-flipped, and 046
 * can be retried independently of this step.
 */
exports.up = async (knex) => {
  for (const table of ['rooms', 'class_sessions', 'bookings']) {
    const [orphans] = await knex.raw(`SELECT COUNT(*) AS n FROM ${table} WHERE center_id IS NULL`);
    if (Number(orphans[0].n) > 0) {
      throw new Error(`${orphans[0].n} rows in ${table} have no center_id — re-run 046 before enforcing NOT NULL`);
    }
    await knex.raw(`ALTER TABLE ${table} MODIFY center_id INT UNSIGNED NOT NULL`);
  }
};

exports.down = async (knex) => {
  for (const table of ['rooms', 'class_sessions', 'bookings']) {
    await knex.raw(`ALTER TABLE ${table} MODIFY center_id INT UNSIGNED NULL`).catch(() => {});
  }
};
