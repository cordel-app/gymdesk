/**
 * #625: Limit Membership Fee Benefit duration to the Promotion duration.
 *
 * A Promotion Period Benefit belongs to the Promotion lifecycle and can never
 * continue applying after the Promotion has ended. Going forward the API
 * rejects an explicit `duration_months` greater than the Promotion's total
 * duration (`free_months + paid_months + bonus_months`), but rows created
 * before this rule could already hold an over-long value.
 *
 * This is a one-off data cleanup: clamp any existing Membership Fee Benefit
 * whose `duration_months` exceeds its owning Promotion's total duration down to
 * that duration. `promotion_period_benefits` only backs the Membership Fee
 * Benefit singleton (#551) now, but the join on `charge_types.code =
 * 'membership_fee'` keeps this precise regardless. NULL durations (unbounded)
 * are left untouched — the forecast/billing already treats them as "the whole
 * Promotion". Pay Beforehand is intentionally excluded from the sum: it only
 * reclassifies paid months as prepaid, it never lengthens the Promotion.
 *
 * Edge case: a Promotion with all-NULL (or all-zero) Free/Paid/Bonus months has
 * a total duration of 0, so a Membership Fee Benefit configured with a positive
 * duration is clamped to 0 here. That is benign and correct — the read path
 * (`effectiveBenefitDurationMonths`) already resolves such a benefit to 0
 * months (it never applies), and no CHECK requires `duration_months > 0`.
 */

const PROMO_DURATION_SQL =
  'GREATEST(0, COALESCE(p.free_months, 0)) + ' +
  'GREATEST(0, COALESCE(p.paid_months, 0)) + ' +
  'GREATEST(0, COALESCE(p.bonus_months, 0))';

exports.up = async (knex) => {
  await knex.raw(
    `UPDATE promotion_period_benefits ppb
       JOIN charge_types ct ON ct.id = ppb.charge_type_id AND ct.code = 'membership_fee'
       JOIN promotions p ON p.id = ppb.promotion_id AND p.gym_id = ppb.gym_id
        SET ppb.duration_months = ${PROMO_DURATION_SQL}
      WHERE ppb.duration_months IS NOT NULL
        AND ppb.duration_months > ${PROMO_DURATION_SQL}`,
  );
};

exports.down = async () => {
  // Data-cleanup only: the pre-clamp durations are not recoverable and there is
  // nothing to revert. Intentionally a no-op.
};
