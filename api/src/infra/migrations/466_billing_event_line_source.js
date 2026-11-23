/**
 * #3254 — a Billing Event Line says where it comes from: `source` is `plan` (the Membership Fee, or
 * a Product a Membership Plan includes) or `product` (a Product bought on its own: a recurring
 * Product line or a one-time purchase). NULL means neither can be named (an adjustment, or a
 * historical line whose origin is ambiguous). It is a classification, not a reference: no FK and no
 * snapshot pointer (#3122 stage 1 stays reverted). Written once by the line's writer
 * (`writeEventLines()`), never rewritten.
 *
 * Backfill, conservative (a line is classified only where its origin is determinable):
 *   - a `membership_fee` line                         -> plan
 *   - a `product` line whose Product is among the event's Product Set plan snapshot lines and
 *     not among its recurring lines nor its purchases -> plan
 *   - a `product` line whose Product is among the set's recurring lines, the event's one-time
 *     purchases, or whose event is a `product_purchase`, and not among the plan lines -> product
 *   - anything else stays NULL and is counted in the migration log.
 * Each step is guarded, so an interrupted run can re-run.
 */
const TABLE = 'billing_event_lines';
const CHECK = 'chk_bel_source';

const checkExists = async (knex) => (await knex.raw(
  `SELECT 1 FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE()
      AND TABLE_NAME = ? AND CONSTRAINT_NAME = ?`, [TABLE, CHECK]))[0].length > 0;

const PLAN_LINES = ['plan_session_snapshots', 'plan_oneoff_snapshots', 'plan_periodical_snapshots']
  .map((t) => `SELECT pl.product_id FROM ${t} pl
      JOIN product_set_plan_snapshots psp ON psp.plan_snapshot_id = pl.plan_snapshot_id
     WHERE psp.product_set_id = be.product_set_id AND pl.product_id = bel.product_id`)
  .map((q) => `EXISTS (${q})`).join(' OR ');

const PRODUCT_LINES = [
  `be.event_type = 'product_purchase'`,
  `EXISTS (SELECT 1 FROM product_periodical_snapshots pp
      JOIN product_set_periodical_snapshots psq ON psq.product_periodical_snapshot_id = pp.id
     WHERE psq.product_set_id = be.product_set_id AND pp.product_id = bel.product_id)`,
  `EXISTS (SELECT 1 FROM product_oneoff_snapshots po
      JOIN billing_event_oneoff_snapshots beo ON beo.product_oneoff_snapshot_id = po.id
     WHERE beo.billing_event_id = be.id AND po.product_id = bel.product_id)`,
  `EXISTS (SELECT 1 FROM product_session_snapshots ps
      JOIN billing_event_session_snapshots bes ON bes.product_session_snapshot_id = ps.id
     WHERE bes.billing_event_id = be.id AND ps.product_id = bel.product_id)`,
].join(' OR ');

exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn(TABLE, 'source'))) {
    await knex.raw(`ALTER TABLE ${TABLE} ADD COLUMN source VARCHAR(16) NULL AFTER kind`);
  }
  if (!(await checkExists(knex))) {
    await knex.raw(`ALTER TABLE ${TABLE} ADD CONSTRAINT ${CHECK} CHECK (source IS NULL OR source IN ('plan', 'product'))`);
  }

  await knex.raw(`UPDATE ${TABLE} SET source = 'plan' WHERE source IS NULL AND kind = 'membership_fee'`);
  await knex.raw(`
    UPDATE ${TABLE} bel JOIN billing_events be ON be.id = bel.billing_event_id
       SET bel.source = CASE
             WHEN (${PLAN_LINES}) AND NOT (${PRODUCT_LINES}) THEN 'plan'
             WHEN (${PRODUCT_LINES}) AND NOT (${PLAN_LINES}) THEN 'product'
             ELSE NULL END
     WHERE bel.source IS NULL AND bel.kind = 'product' AND bel.product_id IS NOT NULL`);

  const [[{ n }]] = await knex.raw(`SELECT COUNT(*) AS n FROM ${TABLE} WHERE source IS NULL AND kind <> 'adjustment'`);
  if (Number(n) > 0) {
    // eslint-disable-next-line no-console
    console.log(`[466] ${n} billing_event_lines left with source NULL: origin not determinable (both or neither).`);
  }
};

exports.down = async (knex) => {
  if (await checkExists(knex)) await knex.raw(`ALTER TABLE ${TABLE} DROP CHECK ${CHECK}`);
  if (await knex.schema.hasColumn(TABLE, 'source')) await knex.raw(`ALTER TABLE ${TABLE} DROP COLUMN source`);
};
