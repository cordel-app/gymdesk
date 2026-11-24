/**
 * #3309 — a payment attempt the member cancelled from the Members App reads
 * `cancelled`, never `expired`.
 *
 * Widens `chk_payment_requests_status` (migration 104: pending | completed |
 * failed | expired) with `cancelled`. Its one writer is
 * `returnCancelledCheckoutToCart()` (`api/src/api/product-set-cancellation.ts`):
 * a member's Cancel on a Pending Payment returns the purchase to In Cart and
 * closes its open attempts as `cancelled`, keeping them (and their Billing
 * Event, stamped `cancelled_at`) as history. An attempt that genuinely times
 * out is still `expired`; nothing is backfilled, because an `expired` row
 * written before this migration cannot be told apart from a real expiry.
 *
 * DROP + ADD of a CHECK on `payment_requests` (no ALGORITHM=COPY concern beyond
 * the existing table's size: the CHECK change is validated against every row,
 * all of which already satisfy the wider set). `down` narrows it again after
 * moving any `cancelled` row to `expired` (the closest older value).
 */
const NEW = "status IN ('pending','completed','failed','expired','cancelled')";
const OLD = "status IN ('pending','completed','failed','expired')";

async function hasCheck(knex) {
  const [rows] = await knex.raw(
    `SELECT CHECK_CLAUSE FROM information_schema.CHECK_CONSTRAINTS
      WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_NAME = 'chk_payment_requests_status'`);
  return rows[0]?.CHECK_CLAUSE ?? null;
}

exports.up = async (knex) => {
  const clause = await hasCheck(knex);
  if (clause && clause.includes('cancelled')) return;
  // One statement, so the table is never without the constraint.
  await knex.raw(clause
    ? `ALTER TABLE payment_requests DROP CHECK chk_payment_requests_status, ADD CONSTRAINT chk_payment_requests_status CHECK (${NEW})`
    : `ALTER TABLE payment_requests ADD CONSTRAINT chk_payment_requests_status CHECK (${NEW})`);
};

exports.down = async (knex) => {
  const clause = await hasCheck(knex);
  if (!clause || !clause.includes('cancelled')) return;
  await knex.raw("UPDATE payment_requests SET status = 'expired' WHERE status = 'cancelled'");
  await knex.raw(`ALTER TABLE payment_requests DROP CHECK chk_payment_requests_status, ADD CONSTRAINT chk_payment_requests_status CHECK (${OLD})`);
};
