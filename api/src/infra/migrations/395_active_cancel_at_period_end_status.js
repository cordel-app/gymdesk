/**
 * #2659 stage 1 (#2125's agreed lifecycle): `active_cancel_at_period_end`
 * joins the stored statuses of `user_memberships`. It is the persisted form
 * of what `LIFECYCLE_STATUS_SQL` derives today as *Cancels on End Date*: a plan
 * the member cancelled that entitles them until `ends_at`. Nothing writes the
 * value in this stage — every reader treats it as it treats `cancelled` — so
 * the widening moves no row and no behaviour. Stage 2 writes it.
 *
 * Migration 328's device: drop and re-add the CHECK with the full list. The
 * value is 27 characters, so `status` is widened from VARCHAR(20) to
 * VARCHAR(40) first (same NOT NULL and DEFAULT).
 * It pays `ALGORITHM=COPY` on `user_memberships`, so merge it outside the
 * nightly runs. The `down` refuses while a row holds the value: mapping one
 * back to `cancelled` is the operator's call.
 */
const ER_CHECK_CONSTRAINT_NOT_FOUND = 3940;
const CHECK = 'user_memberships_status_check';
const NARROW = ['draft', 'pending_payment', 'active', 'paused', 'cancelled', 'expired', 'superseded'];
const WIDE = [...NARROW, 'active_cancel_at_period_end'];

const setCheck = async (knex, values) => {
  await knex.raw(`ALTER TABLE user_memberships DROP CHECK ${CHECK}`).catch((err) => {
    if (err.errno !== ER_CHECK_CONSTRAINT_NOT_FOUND) throw err;
  });
  await knex.raw(
    `ALTER TABLE user_memberships ADD CONSTRAINT ${CHECK} CHECK (status IN (${values.map((v) => `'${v}'`).join(',')}))`,
  );
};

const setWidth = (knex, width) => knex.raw(
  `ALTER TABLE user_memberships MODIFY COLUMN status VARCHAR(${width}) NOT NULL DEFAULT 'active'`,
);

exports.up = async (knex) => {
  await setWidth(knex, 40);
  await setCheck(knex, WIDE);
};

exports.down = async (knex) => {
  const [rows] = await knex.raw(
    "SELECT COUNT(*) AS n FROM user_memberships WHERE status = 'active_cancel_at_period_end'",
  );
  if (Number(rows[0]?.n ?? 0) > 0) {
    throw new Error(
      `395_active_cancel_at_period_end_status: ${rows[0].n} user_memberships row(s) are ` +
      "'active_cancel_at_period_end'. Set them to 'cancelled' by SQL (their ends_at is already " +
      'the last paid day) and re-run. Nothing has been touched.',
    );
  }
  await setCheck(knex, NARROW);
  await setWidth(knex, 20);
};
