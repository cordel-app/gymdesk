/**
 * #371: Manually create a system Sellable Item — Personal Training Class
 * Package (10 Sessions) — for every gym.
 *
 * Data/setup only: no model or API changes. The ticket's "Active — Only
 * Internal" status maps onto the status/enrollment_status split introduced
 * by #370: status='active', enrollment_status='staff_only' — staff can
 * sell it through internal flows, Members cannot purchase it directly.
 *
 * - type='sessions', units=10, is_system=1, charge_type_id left NULL (same
 *   convention as other non-legacy custom/system Sellable Items — see
 *   migration 102/103).
 * - validity_days=182: gym_charges only stores a fixed day count (no
 *   month-based validity field exists), so 6 calendar months is
 *   approximated as 365.25 / 12 * 6 rounded to 182 days.
 * - tax_rate_id: each gym's own system default tax rate (is_system=1,
 *   not deleted) — the same lookup migration 113 used to backfill
 *   gym_charges.tax_rate_id.
 * - amount left NULL — price stays configurable via the normal Sellable
 *   Item admin flow, per the ticket ("do not invent a price").
 * - gym_charges.name has no localization columns/mechanism today, so per
 *   the ticket this migration does not introduce one; only the English
 *   name is stored.
 * - Idempotent: skips gyms that already have this system item.
 */

const ITEM_NAME = 'Personal Training Class Package (10 Sessions)';

exports.up = async (knex) => {
  await knex.raw(
    `
    INSERT INTO gym_charges
      (gym_id, name, type, units, status, enrollment_status, is_system,
       validity_days, tax_rate_id, currency, tax_behavior,
       created_at, modified_at)
    SELECT
      g.id, ?, 'sessions', 10, 'active', 'staff_only', 1,
      182, tr.id, 'EUR', 'inclusive',
      UTC_TIMESTAMP(), UTC_TIMESTAMP()
    FROM gyms g
    LEFT JOIN tax_rates tr
      ON tr.gym_id = g.id AND tr.is_system = 1 AND tr.deleted_at IS NULL
    WHERE NOT EXISTS (
      SELECT 1 FROM gym_charges gc
      WHERE gc.gym_id = g.id AND gc.is_system = 1 AND gc.name = ?
    )
    `,
    [ITEM_NAME, ITEM_NAME],
  );
};

exports.down = async (knex) => {
  await knex('gym_charges')
    .where({ is_system: 1, type: 'sessions', units: 10, name: ITEM_NAME })
    .delete();
};
