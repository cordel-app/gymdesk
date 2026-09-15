/**
 * #487 (stage 2): fix a pre-existing bug in `promotion_charge_benefits`'s
 * action CHECK constraint.
 *
 * Migration 102 (`102_promotions_v3.js`) tried to widen the action CHECK to
 * include 'fixed_price' by dropping `pcb_action_check` and re-adding it —
 * but the constraint actually in place at the time (added by migration 092,
 * `092_promotion_charge_benefits_gym_charge.js`) was named `chk_prcb_action`,
 * not `pcb_action_check`. The DROP silently no-opped (guarded by `.catch`)
 * and 102 added a second, differently-named constraint alongside it. MySQL
 * requires every CHECK constraint on a table to pass, so the stale 4-value
 * `chk_prcb_action` (no 'fixed_price') has been silently rejecting every
 * `fixed_price` charge benefit ever since, even though `pcb_action_check`
 * (5 values, added by 102) allows it and the API/UI have treated
 * 'fixed_price' as supported (`promotion-details.ts` VALID_ACTIONS).
 *
 * This drops the stale constraint so `pcb_action_check` is the sole action
 * gate, matching the behavior the API has assumed since 102.
 */

exports.up = async (knex) => {
  await knex.raw('ALTER TABLE promotion_charge_benefits DROP CHECK chk_prcb_action').catch(() => {});
};

exports.down = async (knex) => {
  await knex.raw(
    "ALTER TABLE promotion_charge_benefits ADD CONSTRAINT chk_prcb_action " +
    "CHECK (action IN ('no_benefit','waive','percentage_discount','fixed_discount'))",
  ).catch(() => {});
};
