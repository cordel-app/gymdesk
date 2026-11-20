/**
 * #3122 stage 1: a Billing Event Line records the contractual snapshot that originated it.
 *
 * `plan_snapshot_id` -> `plan_snapshots.id` (a Membership Fee line) and
 * `product_periodical_snapshot_id` -> `product_periodical_snapshots.id` (a recurring Product line).
 * Both are nullable (adjustments, purchases and lines whose origin cannot be named unambiguously carry
 * none) and `ON DELETE SET NULL`: the line keeps its own economic values, a deleted snapshot only loses
 * the pointer. Additive: `billing_events.product_set_id` stays until the readers move (stage 2) and the
 * column is dropped (stage 3). No historical line is rewritten here.
 */
exports.up = async (knex) => {
  await knex.raw(`
    ALTER TABLE billing_event_lines
      ADD COLUMN plan_snapshot_id INT UNSIGNED NULL,
      ADD COLUMN product_periodical_snapshot_id INT UNSIGNED NULL,
      ADD KEY idx_bel_plan_snapshot (plan_snapshot_id),
      ADD KEY idx_bel_prperiod_snapshot (product_periodical_snapshot_id)`);
  await knex.raw(`
    ALTER TABLE billing_event_lines
      ADD CONSTRAINT fk_bel_plan_snapshot FOREIGN KEY (plan_snapshot_id) REFERENCES plan_snapshots (id) ON DELETE SET NULL,
      ADD CONSTRAINT fk_bel_prperiod_snapshot FOREIGN KEY (product_periodical_snapshot_id) REFERENCES product_periodical_snapshots (id) ON DELETE SET NULL`);
};

exports.down = async (knex) => {
  await knex.raw(`ALTER TABLE billing_event_lines DROP FOREIGN KEY fk_bel_plan_snapshot, DROP FOREIGN KEY fk_bel_prperiod_snapshot`);
  await knex.raw(`ALTER TABLE billing_event_lines DROP KEY idx_bel_plan_snapshot, DROP KEY idx_bel_prperiod_snapshot,
    DROP COLUMN plan_snapshot_id, DROP COLUMN product_periodical_snapshot_id`);
};
