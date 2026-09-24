/**
 * #635 stage 5: the Membership Fee Benefit gets its own table, and Charge
 * Benefits leave the Promotion side for good.
 *
 * Where this comes from: the issue thread's answer to stage 4 part 1 —
 * *"it is my expectation that information under promotion_session_benefits,
 * promotion_period_benefits, promotion_membership_fee_benefits and
 * promotion_one_off_benefits is no longer reading from
 * promotion_charge_benefits"* and *"I'd prefer to migrate it to a new and
 * clean structure and no longer reuse the charge benefit which is
 * confusing"*. Stage 4 removed Charge Benefits from Membership Plans
 * (migration 176) and Included Services (migration 177); the Promotion side
 * kept reading two legacy, `charge_types`-keyed tables, which is what this
 * migration retires.
 *
 * What the Membership Fee Benefit looked like until now (#551): the single
 * `promotion_period_benefits` row whose `charge_type_id` is the
 * `membership_fee` charge type — a table built for something else entirely
 * (per-charge-type quantities, migration 093) — *plus*, for promotions
 * configured before #626 removed the Promotion Charge Benefits editor, a
 * `promotion_charge_benefits` row on a Sellable Item of that same charge
 * type. `computeFinalPrice()` applied **both**, so the same concept was
 * spread over two tables with two different expiry rules.
 *
 * After this migration there is exactly one place: a singleton
 * `promotion_membership_fee_benefits` row per Promotion, keyed to the
 * Promotion alone. No `charge_type_id`, because "which item" was never a
 * choice — the Membership Fee Benefit is always about the membership fee,
 * and the API already resolved the charge type server-side and refused to
 * accept one from the client.
 *
 * ── §18 (do not delete legacy structures blindly) ─────────────────────────
 *
 * The three tables dropped here, and what still read them before this PR:
 *
 *   - `promotion_charge_benefits` (020 / 092 / 102 / 145) — read by
 *     `computeFinalPrice()` and `fetchLiveBenefits()` for `membership_fee`
 *     rows only, plus the `GET/PUT /promotions/:id/charge-benefits`
 *     endpoints (no UI since #626) and the duplicate-promotion copier. Its
 *     `membership_fee` rows are migrated below; rows on any *other* Sellable
 *     Item are not, and never were: nothing has priced or displayed them
 *     since #626, and §18 rules out reinterpreting them as a Period Benefit
 *     (a Charge Benefit waives/discounts an item, a Period Benefit *charges*
 *     one — the same reasoning migration 176 recorded for the plan side).
 *   - `promotion_period_benefits` (021 / 070 / 093 / 102 / 144 / 162) —
 *     backed the Membership Fee Benefit singleton only, since #550 stage 3
 *     replaced its generic editor with the Sellable-Item-keyed
 *     `promotion_{session,oneoff,periodical}` tables (migration 155). Every
 *     `membership_fee` row is migrated below.
 *   - `promotion_included_benefits` (102) — unused since #550 stage 3 (the
 *     comment in `promotion-details.ts` recorded it as dead then, per the
 *     issue owner's "start from scratch" instruction on #550); no endpoint
 *     and no UI read it. Nothing to migrate.
 *
 * One behaviour does move, deliberately. A legacy Charge Benefit applied in
 * every period the Promotion covered, including its free and bonus months and
 * any regular period inside the Promotion's own window; the benefit that
 * replaces it belongs to a promotional period (#625 — a benefit can never
 * outlast its Promotion). So an assignment whose snapshot carries *only* a
 * membership-fee Charge Benefit projects through the Promotion's timeline from
 * now on, exactly like every other Membership Fee Benefit. That is the point
 * of retiring the concept — a Promotion has one membership-fee rule, not two
 * with different lifetimes — and it costs nothing today, since Promotion
 * Charge Benefits have had no editor since #626.
 *
 * Assigned Plans are otherwise unaffected. Since stage 3 (#714) billing reads the
 * Assigned Plan snapshot, and an applied Promotion's own benefits are frozen
 * onto `user_membership_promotions.snapshot` (migration 149) and the
 * `user_membership_promotion_*_snapshot` tables (156/174) — none of which
 * are touched here. Historical snapshot JSON that still carries
 * `charge_benefits` keeps working: `loadPromotionApplications()` folds a
 * legacy membership-fee Charge Benefit into the same duration-gated shape,
 * which is arithmetically what it always did (it applied for as long as the
 * promotion did — i.e. an unbounded duration).
 *
 * Deployment order, as with migration 176: run this *after* the API build
 * that stops reading the dropped tables is live, or the previous build
 * 500s on `ER_NO_SUCH_TABLE`. Tracked in `docs/go-to-production.md`.
 *
 * `down()` recreates the three tables in the shape head left them and
 * restores the Membership Fee rows into `promotion_period_benefits`, so a
 * rollback keeps the configuration. CREATE TABLE and ADD CONSTRAINT are
 * separate non-transactional statements, so each CHECK is guarded on its own
 * (migrations 155 / 173 / 176 set the precedent).
 */

const hasConstraint = async (knex, table, name) => {
  const [rows] = await knex.raw(
    `SELECT COUNT(*) AS cnt FROM information_schema.TABLE_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ?`,
    [table, name],
  );
  return Number(rows[0].cnt) > 0;
};

exports.up = async (knex) => {
  // ── 1. The new singleton table ────────────────────────────────────────────
  if (!(await knex.schema.hasTable('promotion_membership_fee_benefits'))) {
    await knex.schema.createTable('promotion_membership_fee_benefits', (t) => {
      t.increments('id').primary();
      t.specificType('gym_id', 'char(36)').notNullable()
        .references('id').inTable('gyms').onDelete('CASCADE');
      t.integer('promotion_id').unsigned().notNullable()
        .references('id').inTable('promotions').onDelete('CASCADE');
      // Carried over from the Period Benefit shape the section has always
      // been edited in (quantity × frequency is displayed and saved by the
      // Membership Fee editor); `action`/`value` are what billing applies.
      t.integer('quantity').unsigned().notNullable().defaultTo(1);
      t.integer('frequency_interval').unsigned().notNullable().defaultTo(1);
      t.string('frequency_unit', 10).notNullable().defaultTo('month');
      // NULL = unbounded, i.e. the whole Promotion (see
      // effectiveBenefitDurationMonths in domain/promotionBenefits.ts).
      t.integer('duration_months').unsigned().nullable();
      t.tinyint('enabled').notNullable().defaultTo(1);
      t.string('action', 30).nullable();
      t.decimal('value', 10, 2).nullable();
      t.datetime('created_at').notNullable().defaultTo(knex.raw('(UTC_TIMESTAMP())'));
      // One Membership Fee Benefit per Promotion — the endpoint is a
      // singleton PUT, this is the backstop.
      t.unique(['promotion_id'], { indexName: 'pmfb_promotion_unique' });
      t.index(['gym_id'], 'pmfb_gym_id_index');
    });
  }
  if (!(await hasConstraint(knex, 'promotion_membership_fee_benefits', 'chk_pmfb_action'))) {
    await knex.raw(
      'ALTER TABLE promotion_membership_fee_benefits ADD CONSTRAINT chk_pmfb_action ' +
      "CHECK (action IS NULL OR action IN ('no_benefit','waive','percentage_discount','fixed_discount','fixed_price'))",
    );
  }
  if (!(await hasConstraint(knex, 'promotion_membership_fee_benefits', 'chk_pmfb_frequency_unit'))) {
    await knex.raw(
      'ALTER TABLE promotion_membership_fee_benefits ADD CONSTRAINT chk_pmfb_frequency_unit ' +
      "CHECK (frequency_unit IN ('week','month'))",
    );
  }
  if (!(await hasConstraint(knex, 'promotion_membership_fee_benefits', 'chk_pmfb_positive'))) {
    await knex.raw(
      'ALTER TABLE promotion_membership_fee_benefits ADD CONSTRAINT chk_pmfb_positive ' +
      'CHECK (quantity > 0 AND frequency_interval > 0)',
    );
  }

  // ── 2. Migrate the existing Membership Fee Benefits ───────────────────────
  // Decided in memory first, written once per Promotion. Doing it in JS rather
  // than as INSERT … SELECT is forced twice over: the charge-benefit pass has
  // to know what the period-benefit pass chose, and MySQL refuses a subquery
  // on the INSERT target inside the same statement. Deciding before writing
  // also makes a re-run after a crash (the DDL below is not transactional)
  // land on exactly the same rows instead of colliding with its own previous
  // attempt on `pmfb_promotion_unique`.
  const chosen = new Map();
  // Whether a chosen row actually prices anything. An action-less or disabled
  // Period Benefit row never did — the old computeFinalPrice() required
  // `enabled = 1 AND action IS NOT NULL` — while a legacy Charge Benefit
  // applied unconditionally, so an inert row must not shadow one.
  const prices = (row) => !!row.enabled && row.action != null && row.action !== 'no_benefit';

  if (await knex.schema.hasTable('promotion_period_benefits')) {
    const [rows] = await knex.raw(
      `SELECT p.gym_id, ppb.promotion_id, ppb.quantity, ppb.frequency_interval, ppb.frequency_unit,
              ppb.duration_months, ppb.enabled, ppb.action, ppb.value
       FROM promotion_period_benefits ppb
       JOIN charge_types ct ON ct.id = ppb.charge_type_id AND ct.code = 'membership_fee'
       JOIN promotions p ON p.id = ppb.promotion_id
       ORDER BY ppb.id ASC`,
    );
    // gym_id comes from the Promotion, not the benefit row: the endpoints are
    // tenant-scoped (`WHERE promotion_id = ? AND gym_id = ?`) while billing
    // matches on `promotion_id` alone, so a row that disagreed with its
    // Promotion would price while being invisible to the editor.
    for (const r of rows) {
      // A pre-#551 database could hold more than one row per promotion; the
      // last one written is the one the singleton endpoint would have
      // updated, so it wins.
      chosen.set(r.promotion_id, {
        gym_id: r.gym_id, quantity: r.quantity, frequency_interval: r.frequency_interval,
        frequency_unit: r.frequency_unit, duration_months: r.duration_months,
        enabled: r.enabled, action: r.action, value: r.value,
      });
    }
  }

  const supersededChargeBenefits = [];
  if (await knex.schema.hasTable('promotion_charge_benefits')) {
    // A legacy Charge Benefit on the membership fee priced exactly like a
    // Period Benefit with no expiry, so it maps one-to-one onto an unbounded
    // (duration_months NULL) row — unless the Promotion already has a
    // Membership Fee Benefit that prices, which is the newer configuration and
    // wins.
    const [rows] = await knex.raw(
      `SELECT p.gym_id, pcb.promotion_id, pcb.action, pcb.value
       FROM promotion_charge_benefits pcb
       JOIN gym_charges gc ON gc.id = pcb.gym_charge_id AND gc.gym_id = pcb.gym_id
       JOIN charge_types ct ON ct.id = gc.charge_type_id AND ct.code = 'membership_fee'
       JOIN promotions p ON p.id = pcb.promotion_id
       WHERE pcb.action IS NOT NULL AND pcb.action <> 'no_benefit'
       ORDER BY pcb.id ASC`,
    );
    for (const r of rows) {
      const existing = chosen.get(r.promotion_id);
      if (existing && prices(existing)) {
        // Both priced, and computeFinalPrice() used to apply them in turn —
        // a singleton can only keep one, so this Promotion's final_price
        // changes on the next recompute. Named in the log below so it can be
        // reviewed against the go-to-production checklist.
        supersededChargeBenefits.push(r);
        continue;
      }
      chosen.set(r.promotion_id, {
        gym_id: r.gym_id, quantity: 1, frequency_interval: 1, frequency_unit: 'month',
        duration_months: null, enabled: 1, action: r.action, value: r.value,
      });
    }
  }

  for (const [promotionId, row] of chosen) {
    await knex.raw(
      `INSERT INTO promotion_membership_fee_benefits
         (gym_id, promotion_id, quantity, frequency_interval, frequency_unit, duration_months, enabled, action, value)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         quantity = VALUES(quantity), frequency_interval = VALUES(frequency_interval),
         frequency_unit = VALUES(frequency_unit), duration_months = VALUES(duration_months),
         enabled = VALUES(enabled), action = VALUES(action), value = VALUES(value)`,
      [row.gym_id, promotionId, row.quantity, row.frequency_interval, row.frequency_unit,
       row.duration_months, row.enabled, row.action, row.value],
    );
  }

  if (supersededChargeBenefits.length > 0) {
    const listed = supersededChargeBenefits
      .map((r) => `${r.promotion_id} (${r.action}${r.value != null ? ` ${r.value}` : ''})`)
      .join(', ');
    console.warn(
      '[178] These Promotions had both a Membership Fee Benefit and a legacy membership-fee ' +
      'Charge Benefit, which used to be applied in turn; only the former survives, so their ' +
      `assignments re-price on the next recompute: ${listed}`,
    );
  }

  // ── 3. Drop the legacy tables ─────────────────────────────────────────────
  // Nothing foreign-keys into any of them (each only points *out*, at
  // gyms/promotions/charge_types/gym_charges), so the order is free.
  await knex.schema.dropTableIfExists('promotion_included_benefits');
  await knex.schema.dropTableIfExists('promotion_period_benefits');
  await knex.schema.dropTableIfExists('promotion_charge_benefits');
};

exports.down = async (knex) => {
  if (!(await knex.schema.hasTable('promotion_charge_benefits'))) {
    await knex.schema.createTable('promotion_charge_benefits', (t) => {
      t.increments('id').primary();
      t.specificType('gym_id', 'char(36)').notNullable()
        .references('id').inTable('gyms').onDelete('CASCADE');
      t.integer('promotion_id').unsigned().notNullable()
        .references('id').inTable('promotions').onDelete('CASCADE');
      t.integer('gym_charge_id').unsigned().notNullable();
      t.string('action', 30).notNullable().defaultTo('no_benefit');
      t.decimal('value', 10, 2).nullable();
      t.datetime('created_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP'));
      t.index(['promotion_id'], 'pcb_promotion_index');
      t.unique(['promotion_id', 'gym_charge_id'], { indexName: 'prcb_promotion_gym_charge_unique' });
    });
  }
  if (!(await hasConstraint(knex, 'promotion_charge_benefits', 'prcb_gym_charge_id_foreign'))) {
    await knex.raw(
      'ALTER TABLE promotion_charge_benefits ADD CONSTRAINT `prcb_gym_charge_id_foreign` ' +
      'FOREIGN KEY (`gym_charge_id`) REFERENCES `gym_charges` (`id`) ON DELETE CASCADE',
    );
  }
  if (!(await hasConstraint(knex, 'promotion_charge_benefits', 'pcb_action_check'))) {
    await knex.raw(
      'ALTER TABLE promotion_charge_benefits ADD CONSTRAINT pcb_action_check ' +
      "CHECK (action IN ('no_benefit','waive','percentage_discount','fixed_discount','fixed_price'))",
    );
  }

  if (!(await knex.schema.hasTable('promotion_period_benefits'))) {
    await knex.schema.createTable('promotion_period_benefits', (t) => {
      t.increments('id').primary();
      t.specificType('gym_id', 'char(36)').notNullable()
        .references('id').inTable('gyms').onDelete('CASCADE');
      t.integer('promotion_id').unsigned().notNullable()
        .references('id').inTable('promotions').onDelete('CASCADE');
      t.integer('charge_type_id').unsigned().notNullable()
        .references('id').inTable('charge_types');
      t.integer('quantity').unsigned().notNullable();
      t.integer('frequency_interval').unsigned().notNullable();
      t.string('frequency_unit', 10).notNullable();
      t.integer('duration_months').unsigned().nullable();
      t.string('action', 30).nullable();
      t.decimal('value', 10, 2).nullable();
      t.tinyint('enabled').notNullable().defaultTo(1);
      t.datetime('created_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP'));
      t.index(['promotion_id'], 'ppb_promotion_idx');
    });
  }
  if (!(await hasConstraint(knex, 'promotion_period_benefits', 'ppb_frequency_check'))) {
    await knex.raw(
      'ALTER TABLE promotion_period_benefits ADD CONSTRAINT ppb_frequency_check ' +
      "CHECK (frequency_unit IN ('week','month'))",
    );
  }
  if (!(await hasConstraint(knex, 'promotion_period_benefits', 'ppb_positive_check'))) {
    await knex.raw(
      'ALTER TABLE promotion_period_benefits ADD CONSTRAINT ppb_positive_check ' +
      'CHECK (quantity > 0 AND frequency_interval > 0)',
    );
  }
  if (!(await hasConstraint(knex, 'promotion_period_benefits', 'ppb_action_check'))) {
    await knex.raw(
      'ALTER TABLE promotion_period_benefits ADD CONSTRAINT ppb_action_check ' +
      "CHECK (action IS NULL OR action IN ('no_benefit','waive','percentage_discount','fixed_discount','fixed_price'))",
    );
  }

  if (!(await knex.schema.hasTable('promotion_included_benefits'))) {
    await knex.schema.createTable('promotion_included_benefits', (t) => {
      t.increments('id').primary();
      t.specificType('gym_id', 'char(36)').notNullable()
        .references('id').inTable('gyms').onDelete('CASCADE');
      t.integer('promotion_id').unsigned().notNullable()
        .references('id').inTable('promotions').onDelete('CASCADE');
      t.integer('charge_type_id').unsigned().notNullable()
        .references('id').inTable('charge_types');
      t.integer('quantity').unsigned().notNullable().defaultTo(1);
      t.datetime('created_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP'));
      t.index(['promotion_id'], 'pib_promotion_idx');
    });
  }
  if (!(await hasConstraint(knex, 'promotion_included_benefits', 'pib_positive_check'))) {
    await knex.raw(
      'ALTER TABLE promotion_included_benefits ADD CONSTRAINT pib_positive_check CHECK (quantity > 0)',
    );
  }

  // Put the Membership Fee Benefits back where #551 kept them, so rolling
  // back keeps the configuration rather than silently clearing it. A
  // database without the `membership_fee` charge type has nowhere to put
  // them, and the rows are simply dropped with the table below.
  if (await knex.schema.hasTable('promotion_membership_fee_benefits')) {
    await knex.raw(
      `INSERT INTO promotion_period_benefits
         (gym_id, promotion_id, charge_type_id, quantity, frequency_interval, frequency_unit,
          duration_months, action, value, enabled)
       SELECT mf.gym_id, mf.promotion_id, ct.id, mf.quantity, mf.frequency_interval, mf.frequency_unit,
              mf.duration_months, mf.action, mf.value, mf.enabled
       FROM promotion_membership_fee_benefits mf
       JOIN charge_types ct ON ct.code = 'membership_fee'`,
    );
    await knex.schema.dropTableIfExists('promotion_membership_fee_benefits');
  }
};
