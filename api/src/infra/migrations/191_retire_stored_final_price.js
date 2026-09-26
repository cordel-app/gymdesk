/**
 * #635 stage 15 — date-aware Membership Fee pricing becomes standard behaviour,
 * and `user_memberships.final_price` is gone.
 *
 * Stage 12 made one rule decide what the Membership Fee costs on a date
 * (`resolveMembershipFee`), but shipped it behind
 * `billing.date_aware_membership_fee` (seeded off, migration 186) so the impact
 * could be reviewed before it moved money — with
 * `GET /user-memberships/reports/membership-fee-drift` (and its own
 * `payments.membership_fee_drift` key, migration 190) reporting what the
 * correction would change. The thread's answer to that review was to stop
 * switching it: *"remove the billing.date_aware_membership_fee feature flag
 * entirely, as well as the stored final_price approach. Date-aware Membership
 * Fee pricing should be standard system behaviour, with pricing calculated
 * dynamically in the Assigned Membership Plan simulation."*
 *
 * So all three rows go: the two flags, because the behaviour they gated is now
 * unconditional and a *missing* key reads as enabled (see
 * `api/src/infra/featureFlags.ts`) — and the drift report itself, which is empty
 * by construction once nothing is stored to drift from.
 *
 * ── Why the column can go ──────────────────────────────────────────────────
 *
 * `final_price` was a single number with no date in it, recomputed at every
 * promotion apply/revoke. Every path that priced a cycle already resolves it
 * from the assignment's own snapshot instead: its frozen regular fee
 * (`membership_fee_price`), its Billing & Duration and each standing
 * Promotion's own timeline. The one job left to `final_price` was
 * `regularMembershipFee()`'s *last resort* — the number to discount from for an
 * assignment that has no frozen fee, no Plan price window covering its start
 * date and no non-zero `base_price`.
 *
 * That is what the first backfill below preserves, and only that:
 * `membership_fee_price` is written from `final_price` exactly where the chain
 * would have returned `final_price` anyway. Copying it more widely would be
 * wrong in the other direction — `final_price` has the applied Promotions baked
 * into it, so making it an assignment's *regular* fee would freeze a
 * promotional discount into the contract for ever, which is the bug stage 12
 * existed to fix.
 *
 * ── The negotiated price the snapshot never carried (#777) ─────────────────
 *
 * One row shape slips through that reasoning: an assignment created with a
 * price override before this migration, whose Plan has a price window covering
 * its start date. Until stage 15 `POST /user-memberships` (and
 * `/:id/assign-new-plan`, and a `PUT /:id` carrying a price) wrote the agreed
 * price to `final_price` with the `discount_reason` it still requires, while
 * `membership_fee_price` took the Plan's **catalogue** price — the window
 * covering `starts_at` — from `snapshotAssignedPlan()` for a row created after
 * migration 174 and from 174's own backfill for one created before it. Both
 * pre-stage-15 paths still honoured the agreement (the run charged
 * `final_price` flat; the date-aware branch read the manual discount first),
 * but after this migration
 * `regularMembershipFee()` reads the frozen column, so the member would be
 * charged the catalogue fee from the next nightly run. `final_price` is the
 * *discounted* number, so that drift is always upward — the direction the #635
 * thread asked not to let happen silently.
 *
 * The second backfill moves that agreement into `membership_fee_price`, which is
 * where a negotiated fee lives since stage 15. Its guards, and why each one:
 *
 *   - `discount_reason` non-empty — the marker of a negotiated price, then as
 *     now, and what keeps this pass to the issue's statement. Two pre-stage-15
 *     shapes fall outside it and are accepted losses, counted in the log below:
 *     a `PUT /:id` that wrote a `final_price` with no reason (it never required
 *     one), and a Plan repricing pushed through `apply-to-assigned-plans`, which
 *     wrote `final_price` but never the frozen fee — after this migration such
 *     an assignment bills the fee frozen at assignment time again.
 *   - `membership_fee_price IS NOT NULL AND <> final_price` — the two row sets
 *     are disjoint by construction (the first pass keys on the column being NULL,
 *     this one on it holding a different number), so no row is written twice,
 *     and `<>` is exact on two `DECIMAL(10,2)` columns, so a row that already
 *     agrees is skipped and a re-run is a no-op.
 *   - `status NOT IN ('cancelled', 'expired')` — a terminal assignment's
 *     configuration is history, not "what was agreed"; nothing bills it.
 *   - no Promotion application at all — *whatever its status today*. A standing
 *     one has its discount baked into `final_price`, and the two components
 *     cannot be separated from a single stored total. But a revoked one is no
 *     better: before stage 15 every apply and revoke *recomputed* `final_price`
 *     from scratch — from the frozen catalogue fee under the date-aware rule,
 *     and from `base_price` (a constant 0 since migration 058) under the legacy
 *     rule every environment actually ran — so once a Promotion has touched the
 *     row the negotiated number is no longer in the column, and a row with a
 *     revoked application typically reads `final_price = 0.00`. Filtering on
 *     `status = 'applied'` would freeze that 0 as a 100 % override that
 *     `apply-to-assigned-plans` then never corrects (it skips a
 *     `discount_reason`). Such an assignment keeps the catalogue fee instead
 *     and is listed in `docs/go-to-production.md` for a staff re-negotiation.
 *   - `discount_expires_at` is deliberately *not* a guard: the column means
 *     "what was agreed", not "what is still in force", and a lapsed agreement
 *     resolves the catalogue price anyway through `regularMembershipFee()`'s
 *     `ignoreFrozenFee`.
 *
 * These rows already carry a frozen fee, so they are captured by definition
 * and no materialisation is needed — that hazard (next section) only applies
 * to the `membership_fee_price IS NULL` set the first pass handles.
 *
 * ── Why the fee is never written on its own ────────────────────────────────
 *
 * `membership_fee_price IS NOT NULL` is one of the seven disjuncts that *define*
 * "this assignment captured a snapshot" (`has_billing_snapshot`,
 * `hasAssignedPlanSnapshot()`), and that fallback is all-or-nothing: writing the
 * fee alone would flip an uncaptured assignment to captured, and every section
 * the write did not mention — its Free Period, Pre-paid and Bonus Durations, its
 * cadence, its three Plan benefit sections — would read back as *nothing* rather
 * than falling through to the Plan. A member inside a free month would start
 * being charged for it.
 *
 * The two row sets overlap by construction, not by accident: the rows migration
 * 174's backfill left uncaptured are exactly those whose Plan had no durations,
 * no billing policy *and* no price window covering `starts_at` — and "no price
 * window covering `starts_at`" is the very condition this backfill keys on. So
 * an uncaptured row is materialised in full first, the same thing
 * `materialiseAssignedPlanSnapshot()` does before an edit and the same values
 * migration 174 wrote, and the fee is written on top.
 *
 * That materialisation is one-way: `down()` restores the column but leaves those
 * rows captured, so they do not regain the live-catalogue fallback. Nothing they
 * bill changes either way — the values written are the ones they already resolved
 * to live, which is migration 174's own argument — but the rollback is not a
 * round trip, and a re-run of `up()` afterwards backfills nothing because every
 * row then has a fee.
 */

const BENEFIT_TABLES = {
  user_membership_session: 'membership_plan_session',
  user_membership_oneoff: 'membership_plan_oneoff',
  user_membership_periodical: 'membership_plan_periodical',
};

// Same fallbacks migration 174 and `snapshotAssignedPlan()` resolve: a *system*
// charge carries neither its own name nor its own type, and both snapshot
// columns are NOT NULL.
const ITEM_NAME_EXPR = "COALESCE(gc.name, ct.name, CONCAT('Sellable Item #', gc.id))";
const ITEM_TYPE_EXPR = "COALESCE(gc.type, 'other')";

/**
 * The rows the fee backfill would touch *and* that own no snapshot yet — the set
 * that has to be materialised in full first. Frozen into a scratch table before
 * anything is written, because every statement below changes what this predicate
 * would match.
 *
 * `DATE(um.starts_at)` is deliberate even though the column is a DATE: it matches
 * `toDateOnly()` at runtime and avoids comparing a DATE against a DATETIME, which
 * would miss a same-day `valid_to`. It sits on the outer column, so the index on
 * `membership_plan_prices (membership_plan_id, valid_from)` stays usable.
 *
 * The `NOT EXISTS` deliberately does not filter `mpp.status`: `effectivePrice()`
 * does not either — it only uses `status = 'inactive'` as an ORDER BY tie-break —
 * so adding a status filter here would change which rows keep a fee.
 */
const BACKFILL_CANDIDATE = `
  um.membership_fee_price IS NULL
  AND um.final_price IS NOT NULL
  AND (um.base_price IS NULL OR um.base_price <= 0)
  AND NOT EXISTS (
    SELECT 1 FROM membership_plan_prices mpp
     WHERE mpp.membership_plan_id = um.membership_plan_id
       AND mpp.gym_id = um.gym_id
       AND mpp.valid_from <= DATE(um.starts_at)
       AND (mpp.valid_to IS NULL OR mpp.valid_to >= DATE(um.starts_at))
  )`;

const UNCAPTURED = `
  um.free_months IS NULL AND um.paid_months IS NULL AND um.bonus_months IS NULL
  AND um.pay_beforehand_months IS NULL
  AND um.recurring_billing_interval IS NULL AND um.recurring_billing_unit IS NULL
  AND um.membership_fee_price IS NULL
  AND NOT EXISTS (SELECT 1 FROM user_membership_session    s WHERE s.user_membership_id = um.id)
  AND NOT EXISTS (SELECT 1 FROM user_membership_oneoff     o WHERE o.user_membership_id = um.id)
  AND NOT EXISTS (SELECT 1 FROM user_membership_periodical r WHERE r.user_membership_id = um.id)`;

/**
 * The negotiated-price rows described in the header: a non-empty
 * `discount_reason`, a frozen fee that disagrees with the agreed one, a
 * non-terminal status and no Promotion application in any status. Exported so
 * the guard test can pin each clause — this predicate reads a column the
 * migration drops, so no integration test can exercise it after the fact.
 *
 * The rows a *later* pass could still have moved but this one leaves behind —
 * the same predicate minus the reason and application guards — are counted
 * into the migration log before the DROP, so the transcript says whether
 * anyone has to act.
 */
const DISAGREEING_FEE = `
  um.final_price IS NOT NULL
  AND um.membership_fee_price IS NOT NULL
  AND um.membership_fee_price <> um.final_price
  AND um.status NOT IN ('cancelled', 'expired')`;

const NEGOTIATED_CANDIDATE = `
  ${DISAGREEING_FEE}
  AND um.discount_reason IS NOT NULL AND TRIM(um.discount_reason) <> ''
  AND NOT EXISTS (
    SELECT 1 FROM user_membership_promotions ump
     WHERE ump.user_membership_id = um.id AND ump.gym_id = um.gym_id
  )`;

exports.up = async (knex) => {
  // Guarded on the column rather than on the backfill: MySQL commits DDL
  // implicitly, so if anything after the DROP fails, `migrate:latest` re-runs
  // `up()` from the top and must skip every statement that reads `final_price`
  // instead of dying on `ER_BAD_FIELD_ERROR`.
  if (await knex.schema.hasColumn('user_memberships', 'final_price')) {
    // ── 1. Materialise the whole snapshot of every uncaptured candidate ──────
    await knex.raw(
      `CREATE TABLE IF NOT EXISTS _m191_materialised (
         user_membership_id INT UNSIGNED NOT NULL PRIMARY KEY)`,
    );
    await knex.raw(
      `INSERT IGNORE INTO _m191_materialised (user_membership_id)
       SELECT um.id FROM user_memberships um
        WHERE ${BACKFILL_CANDIDATE} AND ${UNCAPTURED}`,
    );

    // Benefit rows first: inserting them is itself a capture, so the frozen id
    // set above is what keeps this from being order-dependent. A terminal
    // assignment is skipped, exactly as migration 174 skipped it — its
    // configuration is history, not "what was agreed".
    for (const [target, source] of Object.entries(BENEFIT_TABLES)) {
      await knex.raw(`
        INSERT INTO ${target}
          (gym_id, user_membership_id, gym_charge_id, quantity,
           item_name, item_type, item_billing_frequency, unit_price, currency)
        SELECT um.gym_id, um.id, b.gym_charge_id, b.quantity,
               ${ITEM_NAME_EXPR}, ${ITEM_TYPE_EXPR},
               gc.billing_frequency, COALESCE(gc.amount, 0), gc.currency
          FROM _m191_materialised m
          JOIN user_memberships um ON um.id = m.user_membership_id
          JOIN ${source} b ON b.membership_plan_id = um.membership_plan_id AND b.gym_id = um.gym_id
          JOIN gym_charges gc ON gc.id = b.gym_charge_id
          LEFT JOIN charge_types ct ON ct.id = gc.charge_type_id
         WHERE um.status NOT IN ('cancelled', 'expired')`);
    }

    // Durations and cadence, copied raw — `toPlanDuration()` clamps
    // `pay_beforehand_months` to `paid_months` on read, so the column is stored
    // as the Plan has it, exactly as `snapshotAssignedPlan()` writes it.
    await knex.raw(`
      UPDATE user_memberships um
        JOIN _m191_materialised m ON m.user_membership_id = um.id
        JOIN membership_plans p ON p.id = um.membership_plan_id AND p.gym_id = um.gym_id
        LEFT JOIN billing_policies bp ON bp.membership_plan_id = p.id AND bp.gym_id = um.gym_id
         SET um.free_months = p.free_months,
             um.paid_months = p.paid_months,
             um.bonus_months = p.bonus_months,
             um.pay_beforehand_months = p.pay_beforehand_months,
             um.recurring_billing_interval = bp.recurring_billing_interval,
             um.recurring_billing_unit = bp.recurring_billing_unit`);

    // ── 2. The fee itself ───────────────────────────────────────────────────
    // Preserves the last-resort fee for assignments whose price nothing else can
    // answer for. Without it they would resolve to no fee at all and the nightly
    // run would quietly stop charging them.
    await knex.raw(
      `UPDATE user_memberships um
          SET um.membership_fee_price = um.final_price
        WHERE ${BACKFILL_CANDIDATE}`,
    );

    // ── 3. The negotiated price the snapshot never carried (#777) ───────────
    // Until stage 15 a price override went to `final_price` — the column this
    // migration drops — while `membership_fee_price` took the Plan's catalogue
    // price (from `snapshotAssignedPlan()`, or from migration 174's backfill for
    // an older row). Moving it keeps the member on the price they were sold. An
    // assignment with any Promotion application is skipped: a standing one has
    // its discount baked into `final_price`, and a revoked one had `final_price`
    // recomputed from scratch at the revoke (see the header), so neither column
    // still holds the negotiated number. Runs after pass 2 on purpose: a row
    // pass 2 just wrote now has `membership_fee_price = final_price` and the
    // `<>` guard leaves it alone.
    await knex.raw(
      `UPDATE user_memberships um
          SET um.membership_fee_price = um.final_price
        WHERE ${NEGOTIATED_CANDIDATE}`,
    );

    // What the DROP below makes unrecoverable: a `final_price` that still
    // disagrees with the frozen fee after both passes. `down()` logs the
    // analogous count; the transcript of `migrate:latest` is the one place the
    // go-to-production checklist can read it from afterwards.
    // mysql2 returns `[rows, fields]` from knex.raw, not `{ rows }`.
    const [leftBehind] = await knex.raw(
      `SELECT COUNT(*) AS n FROM user_memberships um WHERE ${DISAGREEING_FEE}`,
    );
    const left = Number(leftBehind?.[0]?.n ?? 0);
    if (left > 0) {
      // eslint-disable-next-line no-console
      console.log(
        `191_retire_stored_final_price: ${left} assignment(s) still carried a final_price `
        + 'that differs from membership_fee_price and were not moved (a Promotion was '
        + 'applied at some point, or there is no discount_reason) — see '
        + 'docs/go-to-production.md before the next billing run.',
      );
    }

    await knex.raw('DROP TABLE IF EXISTS _m191_materialised');

    await knex.schema.alterTable('user_memberships', (t) => {
      t.dropColumn('final_price');
    });
  }

  // Last, and idempotent: deleting these *before* the drop would leave a
  // half-applied migration with no flag rows, and a missing key reads as
  // enabled — which is the money-moving state migration 186 exists to avoid.
  await knex.raw(
    `DELETE FROM feature_flags
      WHERE feature_key IN ('billing.date_aware_membership_fee', 'payments.membership_fee_drift')`,
  );
};

exports.down = async (knex) => {
  // Restore both keys at their pre-stage-15 values first: the corrected pricing
  // was seeded *off* (migration 186 — a missing key reads as enabled, so the row
  // is the safe state), and the drift page followed `payments.transactions`
  // (migration 190).
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

  if (!(await knex.schema.hasColumn('user_memberships', 'final_price'))) {
    await knex.schema.alterTable('user_memberships', (t) => {
      t.decimal('final_price', 10, 2).nullable();
    });
    // Only an assignment with no standing Promotion can be seeded honestly: for
    // those, `final_price` *was* the regular fee. Where a Promotion is applied it
    // had the discount baked in and is unrecoverable — it was derived from
    // promotion snapshots this rollback does not replay — so the column is left
    // NULL. The pre-stage-15 run reads a NULL as "no fee anyone can name" and
    // charges nothing, which is the fail-safe direction (migration 186's own
    // reasoning: on a rollback, never move money upward). Re-price those
    // assignments by re-running an apply/revoke, which is what used to recompute
    // the column, or restore from backup.
    //
    // Nor does the negotiated-price pass (#777) round-trip: for a row it moved,
    // `membership_fee_price` now holds the agreed fee rather than the catalogue
    // one, so the pre-stage-15 lapsed-discount path (`regularMembershipFee()`
    // once `discount_expires_at` is past) reads the negotiated number where it
    // used to read the catalogue. `final_price` itself is seeded correctly —
    // it carried the agreement before, and does again.
    await knex.raw(`
      UPDATE user_memberships um
         SET um.final_price = um.membership_fee_price
       WHERE NOT EXISTS (
         SELECT 1 FROM user_membership_promotions ump
          WHERE ump.user_membership_id = um.id AND ump.status = 'applied')`);
    // mysql2 returns `[rows, fields]` from knex.raw, not `{ rows }`.
    const [counted] = await knex.raw(`
      SELECT COUNT(*) AS n FROM user_memberships um
       WHERE EXISTS (
         SELECT 1 FROM user_membership_promotions ump
          WHERE ump.user_membership_id = um.id AND ump.status = 'applied')`);
    const pending = Number(counted?.[0]?.n ?? 0);
    if (pending > 0) {
      // eslint-disable-next-line no-console
      console.log(
        `191_retire_stored_final_price: ${pending} assignment(s) carry a standing `
        + 'Promotion and were left with a NULL final_price — re-apply/revoke a '
        + 'Promotion on each to recompute it before the next billing run.',
      );
    }
  }
};

exports.BACKFILL_CANDIDATE = BACKFILL_CANDIDATE;
exports.NEGOTIATED_CANDIDATE = NEGOTIATED_CANDIDATE;
exports.DISAGREEING_FEE = DISAGREEING_FEE;
