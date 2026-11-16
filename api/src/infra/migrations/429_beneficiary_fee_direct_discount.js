/**
 * #2945 — an independent Direct Discount (%) per Membership Fee line.
 *
 * A `per_member` plan (#2834) owes one Membership Fee per beneficiary and the Assigned Plan
 * card draws one fee row per beneficiary, but the only discount the fee carried was the
 * assignment's Personal Membership Fee Benefit (#772), so every fee row read and wrote the same
 * percentage. `plan_snapshot_beneficiaries.fee_direct_discount_percent` is that beneficiary's own
 * fee's Direct Discount:
 *
 * - NULL (every existing row, and every new one): the fee follows the assignment's Personal
 *   Membership Fee Benefit, exactly as before, so nothing existing is repriced;
 * - 0..100: that beneficiary's fee is discounted by this percentage instead (0 = no discount).
 *
 * It is the beneficiary row's because the row already is "this member on this plan snapshot": a
 * snapshot copy (copy-on-write, lifecycle copies) copies it with the row, and removing a
 * beneficiary removes its discount. Read only for a `per_member` snapshot; validated by
 * `parseFeeMemberDiscountsInput()` (`domain/feeMemberDiscounts.ts`) and applied by the billing
 * engine's Membership Fee line alone. No CHECK (MySQL rebuilds the table for ADD CONSTRAINT);
 * `ADD COLUMN` of a nullable column is ALGORITHM=INSTANT on MySQL 8. Nothing is backfilled.
 */

exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('plan_snapshot_beneficiaries', 'fee_direct_discount_percent'))) {
    await knex.raw('ALTER TABLE plan_snapshot_beneficiaries ADD COLUMN fee_direct_discount_percent DECIMAL(5,2) NULL');
  }
};

exports.down = async (knex) => {
  if (await knex.schema.hasColumn('plan_snapshot_beneficiaries', 'fee_direct_discount_percent')) {
    await knex.raw('ALTER TABLE plan_snapshot_beneficiaries DROP COLUMN fee_direct_discount_percent');
  }
};
