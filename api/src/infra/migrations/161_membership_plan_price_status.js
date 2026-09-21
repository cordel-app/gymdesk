/**
 * #547: Membership Plan pricing — one current price, everything else is history.
 *
 * The Pricing section no longer lets an admin hand-manage arbitrary price
 * windows ("Add Price"). Saving a new price/VAT closes the current window and
 * opens a new one, so a plan always has exactly one price in force and every
 * superseded price stays in the price history untouched (req. 15 — historical
 * rows are never recomputed).
 *
 * `status` makes that lifecycle explicit:
 *   active   — the price currently in force for the plan
 *   applied  — the price currently in force, already pushed onto the plan's
 *              Assigned Plans via "Apply new price to assigned plans"
 *   inactive — superseded, kept for history only
 *
 * `applied_at` records when that push last ran for the row.
 *
 * `tax_rate_id` / `tax_rate_percent` snapshot the VAT that applied while the
 * price was in force, so the history row still reads correctly ("€60.50 incl.
 * 21% VAT") after the plan's tax rate is changed or the rate itself is edited.
 *
 * Column adds, backfills and the CHECK constraint are guarded independently so a
 * retry after a partial failure can resume — see
 * 135_membership_plans_tax_behavior.js. The CHECK is added last, so its absence
 * is the marker for "this migration never finished": the status backfill keys
 * off that, not off the column, or a crash between the ADD COLUMN and the
 * UPDATE would leave every historical row silently stamped 'active' on resume.
 */

async function constraintExists(knex, name) {
  const [rows] = await knex.raw(
    `SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'membership_plan_prices' AND CONSTRAINT_NAME = ?`,
    [name],
  );
  return rows.length > 0;
}

exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('membership_plan_prices', 'status'))) {
    await knex.schema.alterTable('membership_plan_prices', (t) => {
      t.string('status', 20).notNullable().defaultTo('active');
    });
  }
  if (!(await knex.schema.hasColumn('membership_plan_prices', 'applied_at'))) {
    await knex.schema.alterTable('membership_plan_prices', (t) => {
      t.datetime('applied_at').nullable();
    });
  }
  if (!(await knex.schema.hasColumn('membership_plan_prices', 'tax_rate_id'))) {
    await knex.schema.alterTable('membership_plan_prices', (t) => {
      t.integer('tax_rate_id').unsigned().nullable()
        .references('id').inTable('tax_rates').onDelete('SET NULL');
      t.decimal('tax_rate_percent', 5, 2).nullable();
    });
  }

  // Backfill before the CHECK is added: every window that does not cover today
  // is history. A future-dated window (one an admin scheduled through the old
  // "Add Price" flow) also lands on 'inactive' — it has never been in force —
  // and the API re-derives its status from the dates once it starts: every
  // "what applies now" lookup filters on the window first and only uses status
  // to break a same-day tie, and enrichPlan() derives the status it displays.
  if (!(await constraintExists(knex, 'chk_membership_plan_prices_status'))) {
    await knex.raw(
      `UPDATE membership_plan_prices
          SET status = 'inactive'
        WHERE NOT (valid_from <= UTC_DATE() AND (valid_to IS NULL OR valid_to >= UTC_DATE()))`,
    );
  }

  // Existing rows predate the snapshot: the plan's current tax rate is the best
  // (and only) information available about what VAT they were priced with. The
  // IS NULL filter makes this idempotent on its own, so it needs no guard.
  await knex.raw(
    `UPDATE membership_plan_prices mpp
       JOIN membership_plans mp ON mp.id = mpp.membership_plan_id AND mp.gym_id = mpp.gym_id
       LEFT JOIN tax_rates tr ON tr.id = mp.tax_rate_id AND tr.gym_id = mpp.gym_id
        SET mpp.tax_rate_id = mp.tax_rate_id,
            mpp.tax_rate_percent = tr.rate_percent
      WHERE mpp.tax_rate_id IS NULL`,
  );

  if (!(await constraintExists(knex, 'chk_membership_plan_prices_status'))) {
    await knex.raw(
      'ALTER TABLE membership_plan_prices ADD CONSTRAINT chk_membership_plan_prices_status ' +
      "CHECK (status IN ('active','applied','inactive'))",
    );
  }
};

exports.down = async (knex) => {
  if (await constraintExists(knex, 'chk_membership_plan_prices_status')) {
    await knex.raw('ALTER TABLE membership_plan_prices DROP CHECK chk_membership_plan_prices_status');
  }
  // Guarded on the FK itself, not on the column: dropping the constraint and
  // dropping the column are two statements, and a retry after the first one
  // succeeded would otherwise fail with ER_CANT_DROP_FIELD_OR_KEY.
  if (await constraintExists(knex, 'membership_plan_prices_tax_rate_id_foreign')) {
    await knex.schema.alterTable('membership_plan_prices', (t) => {
      t.dropForeign(['tax_rate_id'], 'membership_plan_prices_tax_rate_id_foreign');
    });
  }
  for (const col of ['tax_rate_percent', 'tax_rate_id', 'applied_at', 'status']) {
    if (await knex.schema.hasColumn('membership_plan_prices', col)) {
      await knex.schema.alterTable('membership_plan_prices', (t) => t.dropColumn(col));
    }
  }
};
