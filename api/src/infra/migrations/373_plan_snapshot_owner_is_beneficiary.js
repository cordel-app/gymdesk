/**
 * #2125 stage 22 — the payer of a Product Set is not a beneficiary of its plans by default.
 *
 * Oscar (2026-11-02): `product_sets.owner_member_id` is who owns the Product Set and pays;
 * `plan_snapshot_beneficiaries` is who receives each plan's services. A payer who does not train
 * on the plan (Peter pays for Mary's and Paul's plan) must not be given its entitlements.
 * Until now every plan snapshot carried an automatic owner beneficiary row, re-added by every sync.
 *
 * `plan_snapshots.owner_is_beneficiary` records the choice. DEFAULT 1 keeps every existing plan
 * exactly as it was (the owner already has a row), so nothing is backfilled or guessed; only a plan
 * created with, or edited to, `owner_is_beneficiary = 0` loses the owner's row.
 *
 * Repeatable (guarded), one column. `down` drops it.
 */
const hasColumn = async (knex) => {
  const [rows] = await knex.raw(
    `SELECT 1 FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'plan_snapshots' AND COLUMN_NAME = 'owner_is_beneficiary'`);
  return rows.length > 0;
};

exports.up = async (knex) => {
  if (await hasColumn(knex)) return;
  await knex.raw('ALTER TABLE plan_snapshots ADD COLUMN owner_is_beneficiary TINYINT(1) NOT NULL DEFAULT 1');
};

exports.down = async (knex) => {
  if (!(await hasColumn(knex))) return;
  await knex.raw('ALTER TABLE plan_snapshots DROP COLUMN owner_is_beneficiary');
};
