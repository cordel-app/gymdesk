/**
 * #635 stage 15: the Membership Fee is computed, never stored.
 *
 * `user_memberships.final_price` held "the agreed price after Promotions",
 * recomputed at every promotion apply/revoke. It is a single number with no date
 * in it, which is precisely what stages 8/11/12 established it cannot be: a cycle
 * inside a Free Period, a Pre-paid Duration or a Bonus Duration costs nothing, and
 * an applied Promotion's Membership Fee Benefit ends with that Promotion's own
 * Free/Paid/Bonus timeline. So every surface that needed a correct price already
 * resolved one through `resolveMembershipFee()`, and the column survived only
 * because the nightly run still charged it while
 * `billing.date_aware_membership_fee` (migration 186) was off — the switch that
 * let the correction be reviewed before it moved money.
 *
 * The #635 thread's answer to that review closes both: *"remove the
 * billing.date_aware_membership_fee feature flag entirely, as well as the stored
 * final_price approach. Date-aware Membership Fee pricing should be standard
 * system behaviour, with pricing calculated dynamically in the Assigned Membership
 * Plan simulation."* With nothing stored there is no second rule left to drift
 * from, so the drift report goes too (its `payments.membership_fee_drift` key,
 * migration 190, would gate a page that can only ever be empty).
 *
 * What an assignment still owns is its **regular** fee — `membership_fee_price`,
 * frozen at assignment time (migration 174) and editable only on the assignment
 * itself (§15). Before dropping the column this migration therefore rescues every
 * number that lives nowhere else, in two passes:
 *
 *   1. **An assignment with no `membership_fee_price` at all** would otherwise
 *      resolve to its Plan's price window, then `base_price` (a constant 0 since
 *      migration 058) — and a fee of 0 reads as *waived*, so the nightly run would
 *      stop billing it in silence. Migration 174's backfill left exactly that
 *      shape behind for a Plan with no price window covering `starts_at`. For such
 *      a row `final_price` is the only surviving number, so it becomes its regular
 *      fee.
 *   2. **A negotiated price** (`discount_reason`) that its snapshot does not
 *      already carry: the agreement is in `final_price` and nowhere else, so it
 *      moves into the column a Promotion now discounts *from*.
 *
 * Both passes skip an assignment carrying a **standing Promotion**, whose
 * `final_price` has that Promotion's discount baked in — copying it would make the
 * Promotion discount its own discounted result on the next cycle. Separating the
 * two is not attempted (it would mean re-running `computeFinalPrice`'s arithmetic
 * backwards inside a migration); the one exception is pass 1's real hazard: an
 * assignment that would be left with *no* fee at all is rescued even then, because
 * a fee that is merely stale beats one that silently bills nothing.
 *
 * Two things the passes deliberately do not do. `discount_expires_at` is not
 * honoured — it is inert in code today (stored and displayed, never priced), and
 * excluding an expired discount here would *raise* a charge this migration has no
 * mandate to touch. And `discount_reason` is taken as the only available evidence
 * of a negotiated price, which it is: no column records whether the price was
 * overridden, and `PUT /user-memberships/:id` can write the reason on its own.
 *
 * **Writing `membership_fee_price` is writing one section of a snapshot**, and the
 * fallback it belongs to is all-or-nothing (CLAUDE.md; `hasAssignedPlanSnapshot()`
 * / `materialiseAssignedPlanSnapshot()`): the moment that column is set on an
 * assignment that captured nothing, its Plan's Free Period, cadence and benefit
 * rows stop being read live and it reads back as an assignment with no durations
 * and no benefits — billing a free month and dropping every included item. So each
 * rescued row that has captured nothing is materialised first, exactly as migration
 * 174's own backfill does, and only then given its fee.
 *
 * Each DDL statement is guarded independently via `information_schema`: MySQL
 * commits DDL implicitly, so a migration that fails halfway must be re-runnable.
 */

/**
 * Pass 1 — the assignments that lose their **only** fee when the column goes.
 *
 * `regularMembershipFee()` resolves `membership_fee_price` → the Plan's price
 * window at `starts_at` → a non-zero `base_price` → nothing, and a fee of nothing
 * reads as €0, which reads as *waived*: the nightly run would write a
 * `waived_billing` event, call no provider and move the schedule on, in silence.
 * A row with none of those three has `final_price` and nothing else.
 *
 * Deliberately not filtered on standing Promotions: for one of these rows the
 * number may carry a Promotion's discount, and freezing a stale fee is still
 * better than billing nothing at all. A row that *can* resolve a fee is left
 * alone — its price window is the better number, and overriding it with whatever
 * `computeFinalPrice()` last wrote would move money for no reason.
 */
const NEEDS_FEE = `
  um.membership_fee_price IS NULL
  AND um.final_price IS NOT NULL AND um.final_price > 0
  AND (um.base_price IS NULL OR um.base_price <= 0)
  AND NOT EXISTS (
    SELECT 1 FROM membership_plan_prices mpp
     WHERE mpp.membership_plan_id = um.membership_plan_id AND mpp.gym_id = um.gym_id
       AND mpp.valid_from <= um.starts_at
       AND (mpp.valid_to IS NULL OR mpp.valid_to >= um.starts_at)
  )`;

/**
 * Pass 2 — a negotiated price (`discount_reason`) the snapshot does not already
 * carry. The agreement is in `final_price` and nowhere else, so it moves into the
 * column a Promotion now discounts *from*; without it the member would start
 * paying their Plan's catalogue price. Skips an assignment carrying a standing
 * Promotion, whose `final_price` has that Promotion's discount baked in.
 */
const NEGOTIATED = `
  um.final_price IS NOT NULL
  AND um.discount_reason IS NOT NULL AND TRIM(um.discount_reason) <> ''
  AND (um.membership_fee_price IS NULL OR um.membership_fee_price <> um.final_price)
  AND NOT EXISTS (
    SELECT 1 FROM user_membership_promotions ump
     WHERE ump.user_membership_id = um.id AND ump.status = 'applied'
  )`;

/** Every row either pass will write a fee onto. */
const MOVED = `((${NEEDS_FEE}) OR (${NEGOTIATED}))`;

/** None of the seven snapshot columns set — the row `materialise` exists for. */
const CAPTURED_NOTHING = `
  um.membership_fee_price IS NULL
  AND um.free_months IS NULL AND um.paid_months IS NULL AND um.bonus_months IS NULL
  AND um.pay_beforehand_months IS NULL
  AND um.recurring_billing_interval IS NULL AND um.recurring_billing_unit IS NULL`;

const BENEFIT_SOURCE = {
  user_membership_session: 'membership_plan_session',
  user_membership_oneoff: 'membership_plan_oneoff',
  user_membership_periodical: 'membership_plan_periodical',
};

// A *system* Sellable Item carries neither name nor type of its own (both
// `gym_charges` columns are nullable) and the snapshot columns are NOT NULL —
// migration 174's own fallbacks, repeated so a materialised row is identical.
const ITEM_NAME_EXPR = "COALESCE(gc.name, ct.name, CONCAT('Sellable Item #', gc.id))";
const ITEM_TYPE_EXPR = "COALESCE(gc.type, 'other')";

async function hasColumn(knex, table, column) {
  const [rows] = await knex.raw(
    `SELECT COUNT(*) AS n FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    [table, column],
  );
  return Number(rows[0].n) > 0;
}

exports.up = async (knex) => {
  if (await hasColumn(knex, 'user_memberships', 'final_price')) {
    // ── Materialise, before any fee is written ────────────────────────────────
    // The Plan's Billing & Duration and cadence, for a rescued row that captured
    // nothing. Same statement shape as migration 174's backfill; only the row set
    // differs, and the fee is written separately below.
    await knex.raw(`
      UPDATE user_memberships um
        JOIN membership_plans p ON p.id = um.membership_plan_id AND p.gym_id = um.gym_id
        LEFT JOIN billing_policies bp ON bp.membership_plan_id = p.id AND bp.gym_id = um.gym_id
      SET um.free_months = p.free_months,
          um.paid_months = p.paid_months,
          um.bonus_months = p.bonus_months,
          um.pay_beforehand_months = p.pay_beforehand_months,
          um.recurring_billing_interval = bp.recurring_billing_interval,
          um.recurring_billing_unit = bp.recurring_billing_unit
      WHERE ${MOVED} AND ${CAPTURED_NOTHING}
    `);

    // …and the Plan's three benefit sections, for a rescued row that has none of
    // that category yet. A `cancelled`/`expired` assignment is left alone, as in
    // migration 174: stamping today's catalogue on it would claim it as "what was
    // agreed".
    for (const [target, source] of Object.entries(BENEFIT_SOURCE)) {
      await knex.raw(`
        INSERT INTO ${target}
          (gym_id, user_membership_id, gym_charge_id, quantity,
           item_name, item_type, item_billing_frequency, unit_price, currency)
        SELECT um.gym_id, um.id, b.gym_charge_id, b.quantity,
               ${ITEM_NAME_EXPR}, ${ITEM_TYPE_EXPR},
               gc.billing_frequency, COALESCE(gc.amount, 0), gc.currency
        FROM user_memberships um
        JOIN ${source} b
          ON b.membership_plan_id = um.membership_plan_id AND b.gym_id = um.gym_id
        JOIN gym_charges gc ON gc.id = b.gym_charge_id
        LEFT JOIN charge_types ct ON ct.id = gc.charge_type_id
        LEFT JOIN ${target} existing ON existing.user_membership_id = um.id
        WHERE existing.id IS NULL
          AND um.status NOT IN ('cancelled', 'expired')
          AND ${MOVED} AND ${CAPTURED_NOTHING}
      `);
    }

    // ── The fee itself ────────────────────────────────────────────────────────
    // Pass 1: the assignments that would otherwise be left with no fee at all.
    await knex.raw(`UPDATE user_memberships um SET um.membership_fee_price = um.final_price WHERE ${NEEDS_FEE}`);
    // Pass 2: a negotiated price the snapshot does not already carry. `<>` is
    // exact — both columns are DECIMAL(10,2) — so a row that already agrees is
    // skipped and a re-run is a no-op.
    await knex.raw(`UPDATE user_memberships um SET um.membership_fee_price = um.final_price WHERE ${NEGOTIATED}`);

    // `user_memberships` is the hottest table in the schema, and a plain DROP
    // COLUMN rebuilds it under a metadata lock. INSTANT is O(1) on MySQL 8.0.29+;
    // an older server (or a table whose row format refuses it) falls back to the
    // rebuild rather than failing the deploy.
    try {
      await knex.raw('ALTER TABLE user_memberships DROP COLUMN final_price, ALGORITHM=INSTANT');
    } catch (err) {
      console.warn(`[191] INSTANT drop unavailable (${err.message}); rebuilding the table instead`);
      await knex.raw('ALTER TABLE user_memberships DROP COLUMN final_price');
    }
  }

  // Both flags go with the code that read them. Unlike migration 186's own
  // `down()`, deleting these rows is safe: nothing consults either key any more,
  // so the "a missing key reads as enabled" rule has nothing left to enable.
  await knex.raw(
    `DELETE FROM feature_flags
      WHERE feature_key IN ('billing.date_aware_membership_fee', 'payments.membership_fee_drift')`,
  );
};

exports.down = async (knex) => {
  if (!(await hasColumn(knex, 'user_memberships', 'final_price'))) {
    await knex.raw('ALTER TABLE user_memberships ADD COLUMN final_price DECIMAL(10,2) NULL');
    // The pre-stage-15 code charged this column flat, so what is restored is the
    // number that code would have charged for a cycle no Promotion governs: the
    // assignment's own regular fee, else the Plan's price window at `starts_at`.
    // A Promotion's discount is *not* re-baked in — that is `computeFinalPrice()`'s
    // job, and it runs again on the next apply/revoke.
    //
    // The fee moves of `up()` are not reversed: the agreed price stays on the
    // assignment, which is where §15 says it belongs, so a later re-`up()` finds
    // the columns already in agreement and does nothing.
    await knex.raw(`
      UPDATE user_memberships um
         SET um.final_price = COALESCE(um.membership_fee_price, (
           SELECT mpp.price FROM membership_plan_prices mpp
            WHERE mpp.membership_plan_id = um.membership_plan_id AND mpp.gym_id = um.gym_id
              AND mpp.valid_from <= um.starts_at
              AND (mpp.valid_to IS NULL OR mpp.valid_to >= um.starts_at)
            ORDER BY (mpp.status = 'inactive') ASC, mpp.valid_from DESC, mpp.id DESC
            LIMIT 1
         ))
    `);
  }
  // Each key comes back exactly as the migration that seeded it left it: 186
  // asserts `enabled = 0` on conflict (a row left at 1 would keep the money-moving
  // path on while the migration reported success), and 190 seeds its key from
  // `payments.transactions` so a gym with Transactions off does not find the report
  // newly reachable.
  await knex.raw(
    `INSERT INTO feature_flags (feature_key, enabled, updated_at)
     VALUES ('billing.date_aware_membership_fee', 0, UTC_TIMESTAMP())
     ON DUPLICATE KEY UPDATE enabled = 0, updated_at = UTC_TIMESTAMP()`,
  );
  await knex.raw(
    `INSERT IGNORE INTO feature_flags (feature_key, enabled, updated_at)
     SELECT 'payments.membership_fee_drift',
            COALESCE((SELECT enabled FROM feature_flags WHERE feature_key = 'payments.transactions'), 1),
            UTC_TIMESTAMP()`,
  );
};
