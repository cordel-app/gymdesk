/**
 * #2940 — a Billing Event's name.
 *
 * `billing_events.name` (nullable) is generated once, by the writer that creates
 * the event, from the rule in `api/src/domain/billingEventName.ts`
 * (`Initial Engagement`, `<Gym> - <Month>`, `<Gym> - <Month> (dd/mm/yyyy)`,
 * `<Gym> - <Product or Plan>`, `<Gym> - Compra dd/mm/yyyy`). It is stored rather
 * than derived on read so the Admin app and the Members App show the same text and
 * a later rename of a plan, a product or the gym never rewrites a past event.
 *
 * Nothing is backfilled (§6: existing records keep what they show): a NULL name
 * reads as before (the plan name in the Admin, the event type in the Members App).
 * `ADD COLUMN` of a nullable column is ALGORITHM=INSTANT on MySQL 8.
 */

exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('billing_events', 'name'))) {
    await knex.raw('ALTER TABLE billing_events ADD COLUMN name VARCHAR(255) NULL AFTER event_type');
  }
};

exports.down = async (knex) => {
  if (await knex.schema.hasColumn('billing_events', 'name')) {
    await knex.raw('ALTER TABLE billing_events DROP COLUMN name');
  }
};
