/**
 * #550 stage 1 (completion): hard-delete existing Promotion benefit data.
 *
 * Per the issue owner's explicit clarification on #550 ("no need to maintain
 * any historical data. In this ticket you must hard delete all promotions
 * and start from scratch with the new structure"), the rows in
 * `promotion_period_benefits` and `promotion_included_benefits` are reset
 * now rather than migrated/backfilled into the new `promotion_session` /
 * `promotion_oneoff` / `promotion_periodical` tables (migration 155) — those
 * old tables used the hardcoded `charge_types` pseudo-catalog, not real
 * Sellable Items, so there is nothing meaningful to carry forward.
 *
 * TRUNCATE (not DROP): `promotion-details.ts`, `promotions.ts` and the
 * admin Promotions page still read/write these two tables today — the API
 * cutover to the new Sellable-Item-keyed tables is a later stage (per the
 * staged plan agreed on #550), so the tables must keep existing until that
 * wiring lands. Only the stale data (recorded under the old charge_types
 * scheme) is wiped, mirroring the existing clean-slate precedent in
 * migration 055 (`TRUNCATE TABLE audit_logs`, "decision: clean slate, per
 * ticket clarification"). `promotion_charge_benefits` (the discount
 * mechanism, already keyed to `gym_charge_id`) is untouched — out of scope
 * for this ticket.
 *
 * Idempotent: TRUNCATE always leaves the table empty, so re-running this
 * migration is safe.
 */
exports.up = async (knex) => {
  await knex.raw('TRUNCATE TABLE promotion_period_benefits');
  await knex.raw('TRUNCATE TABLE promotion_included_benefits');
};

exports.down = async () => {
  // Data reset only — the rows wiped here are the old charge_types-keyed
  // Promotion benefits being retired by #550; reverting would just restore
  // stale data under a scheme the ticket removes. No schema change to undo.
};
