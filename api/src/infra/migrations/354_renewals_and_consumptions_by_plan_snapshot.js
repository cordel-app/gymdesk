/**
 * #2125 stage 12 — a plan's Session Benefit allowance is identified by its plan snapshot line.
 *
 * Until now the renewals of a renewing allowance and the consumption ledger named the legacy
 * `user_membership_session` row. A version can hold a second Membership Plan whose included
 * Products exist only in `plan_session_snapshots` (no legacy twin), so both are re-keyed to that
 * table:
 *
 *   plan_allowance_renewals.plan_session_snapshot_id   new FK (CASCADE) + UNIQUE (line, date);
 *                                                      backfilled through `plan_session_snapshots
 *                                                      .source_id` (the legacy line it was copied
 *                                                      from). `user_membership_session_id` becomes
 *                                                      nullable and stays as the frozen record of
 *                                                      older rows; a CHECK keeps at least one set.
 *   professional_service_consumptions.source_reference_id   for `source_kind = 'plan_session'` it now
 *                                                      holds the plan session snapshot id, which is
 *                                                      what `loadMemberProfessionalServiceGrants()`
 *                                                      reports as the grant's reference.
 *
 * Re-run safety: the two id spaces (legacy line ids and snapshot ids) overlap, so the consumptions
 * remap must run exactly once. It runs inside the guard that adds the column, right after it, and
 * every later statement is guarded on its own state — a retry after a partial failure finishes the
 * remaining DDL and never remaps again. A consumption whose legacy line has no snapshot keeps its
 * id (it no longer matches a grant, as a consumption of a deleted line never did), and the count of
 * renewals that found no snapshot is logged.
 *
 * `down` is best-effort, not an inverse: it restores legacy ids for the consumptions that point at
 * a snapshot with a legacy twin, and deletes the renewals that exist only on a native snapshot
 * (they have no legacy line to go back to).
 */
async function constraintExists(knex, table, name) {
  const [rows] = await knex.raw(
    `SELECT 1 FROM information_schema.table_constraints
      WHERE table_schema = DATABASE() AND table_name = ? AND constraint_name = ?`, [table, name]);
  return rows.length > 0;
}
async function indexExists(knex, table, name) {
  const [rows] = await knex.raw(
    `SELECT 1 FROM information_schema.statistics
      WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ? LIMIT 1`, [table, name]);
  return rows.length > 0;
}

exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('plan_allowance_renewals', 'plan_session_snapshot_id'))) {
    await knex.raw(`
      ALTER TABLE plan_allowance_renewals
        ADD COLUMN plan_session_snapshot_id INT UNSIGNED NULL AFTER user_membership_session_id,
        MODIFY COLUMN user_membership_session_id INT UNSIGNED NULL`);
    // Exactly once: see the header.
    await knex.raw(`
      UPDATE professional_service_consumptions c
        JOIN plan_session_snapshots pss ON pss.source_id = c.source_reference_id AND pss.gym_id = c.gym_id
         SET c.source_reference_id = pss.id
       WHERE c.source_kind = 'plan_session'`);
  }
  await knex.raw(`
    UPDATE plan_allowance_renewals par
      JOIN plan_session_snapshots pss ON pss.source_id = par.user_membership_session_id AND pss.gym_id = par.gym_id
       SET par.plan_session_snapshot_id = pss.id
     WHERE par.plan_session_snapshot_id IS NULL AND par.user_membership_session_id IS NOT NULL`);
  const [[orphans]] = await knex.raw(
    'SELECT COUNT(*) AS n FROM plan_allowance_renewals WHERE plan_session_snapshot_id IS NULL');
  if (Number(orphans.n) > 0) {
    console.log(`migration 354: ${orphans.n} renewal(s) name a legacy line with no plan snapshot and no longer count`);
  }
  if (!(await indexExists(knex, 'plan_allowance_renewals', 'par_snapshot_date'))) {
    await knex.raw('ALTER TABLE plan_allowance_renewals ADD UNIQUE KEY par_snapshot_date (plan_session_snapshot_id, renewal_date)');
  }
  if (!(await constraintExists(knex, 'plan_allowance_renewals', 'fk_par_snapshot'))) {
    await knex.raw(`ALTER TABLE plan_allowance_renewals ADD CONSTRAINT fk_par_snapshot
      FOREIGN KEY (plan_session_snapshot_id) REFERENCES plan_session_snapshots (id) ON DELETE CASCADE`);
  }
  if (!(await constraintExists(knex, 'plan_allowance_renewals', 'chk_par_line_ref'))) {
    await knex.raw(`ALTER TABLE plan_allowance_renewals ADD CONSTRAINT chk_par_line_ref
      CHECK (user_membership_session_id IS NOT NULL OR plan_session_snapshot_id IS NOT NULL)`);
  }
};

exports.down = async (knex) => {
  if (!(await knex.schema.hasColumn('plan_allowance_renewals', 'plan_session_snapshot_id'))) return;
  await knex.raw(`
    UPDATE professional_service_consumptions c
      JOIN plan_session_snapshots pss ON pss.id = c.source_reference_id AND pss.gym_id = c.gym_id
       SET c.source_reference_id = pss.source_id
     WHERE c.source_kind = 'plan_session' AND pss.source_id IS NOT NULL`);
  await knex.raw('DELETE FROM plan_allowance_renewals WHERE user_membership_session_id IS NULL AND plan_session_snapshot_id IS NOT NULL');
  if (await constraintExists(knex, 'plan_allowance_renewals', 'chk_par_line_ref')) {
    await knex.raw('ALTER TABLE plan_allowance_renewals DROP CHECK chk_par_line_ref');
  }
  if (await constraintExists(knex, 'plan_allowance_renewals', 'fk_par_snapshot')) {
    await knex.raw('ALTER TABLE plan_allowance_renewals DROP FOREIGN KEY fk_par_snapshot');
  }
  if (await indexExists(knex, 'plan_allowance_renewals', 'par_snapshot_date')) {
    await knex.raw('ALTER TABLE plan_allowance_renewals DROP KEY par_snapshot_date');
  }
  await knex.raw(`
    ALTER TABLE plan_allowance_renewals
      DROP COLUMN plan_session_snapshot_id,
      MODIFY COLUMN user_membership_session_id INT UNSIGNED NOT NULL`);
};
