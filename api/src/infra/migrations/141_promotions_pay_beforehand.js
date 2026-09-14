/**
 * #486: Add Pay Beforehand and Improve Promotion Forecast
 *
 * Adds `pay_beforehand_months` to `promotions`: how many of the Promotion's
 * `paid_months` are already paid beforehand (shown as "Prepaid (promotion)"
 * in the forecast rather than "Pay (promotion)"). Defaults to 0 so existing
 * Promotions keep their current forecast behavior unchanged.
 */
exports.up = async (knex) => {
  const hasPayBeforehandMonths = await knex.schema.hasColumn('promotions', 'pay_beforehand_months');
  if (!hasPayBeforehandMonths) {
    await knex.schema.alterTable('promotions', (t) => {
      t.integer('pay_beforehand_months').unsigned().notNullable().defaultTo(0).after('paid_months');
    });
  }
};

exports.down = async (knex) => {
  const hasPayBeforehandMonths = await knex.schema.hasColumn('promotions', 'pay_beforehand_months');
  if (hasPayBeforehandMonths) {
    await knex.schema.alterTable('promotions', (t) => {
      t.dropColumn('pay_beforehand_months');
    });
  }
};
