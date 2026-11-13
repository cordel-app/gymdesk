/**
 * #2747 stage 1: a Product Set awaiting its first payment can be cancelled, and
 * the cancellation is kept rather than deleted. `cancelled` joins
 * `chk_product_sets_status` (migration 246's list) and `cancelled_at` /
 * `cancelled_by` record when and by whom (#1182's plain-text actor).
 *
 * `pending_owner_key` is `IF(status IN ('draft','pending_payment'), …)`, so a
 * cancelled set leaves the owner's in-flight slot free with no change to it.
 * Nothing is backfilled: no set holds the value yet.
 *
 * Migration 395's device: drop and re-add the CHECK with the full list. It pays
 * `ALGORITHM=COPY` on `product_sets`. The `down` refuses while a row holds the
 * value: what a cancelled set should become is the operator's call.
 */
const ER_CHECK_CONSTRAINT_NOT_FOUND = 3940;
const CHECK = 'chk_product_sets_status';
const NARROW = ['draft', 'pending_payment', 'active', 'superseded'];
const WIDE = [...NARROW, 'cancelled'];

const setCheck = async (knex, values) => {
  await knex.raw(`ALTER TABLE product_sets DROP CHECK ${CHECK}`).catch((err) => {
    if (err.errno !== ER_CHECK_CONSTRAINT_NOT_FOUND) throw err;
  });
  await knex.raw(
    `ALTER TABLE product_sets ADD CONSTRAINT ${CHECK} CHECK (status IN (${values.map((v) => `'${v}'`).join(',')}))`,
  );
};

exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('product_sets', 'cancelled_at'))) {
    await knex.raw(`
      ALTER TABLE product_sets
        ADD COLUMN cancelled_at DATETIME NULL,
        ADD COLUMN cancelled_by VARCHAR(255) NULL`);
  }
  await setCheck(knex, WIDE);
};

exports.down = async (knex) => {
  const [rows] = await knex.raw("SELECT COUNT(*) AS n FROM product_sets WHERE status = 'cancelled'");
  if (Number(rows[0]?.n ?? 0) > 0) {
    throw new Error(
      `410_product_set_cancelled_status: ${rows[0].n} product_sets row(s) are 'cancelled'. ` +
      'Decide what each should become and update it by SQL, then re-run. Nothing has been touched.',
    );
  }
  await setCheck(knex, NARROW);
  if (await knex.schema.hasColumn('product_sets', 'cancelled_at')) {
    await knex.raw('ALTER TABLE product_sets DROP COLUMN cancelled_at, DROP COLUMN cancelled_by');
  }
};
