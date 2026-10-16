/**
 * #1657 stage 2 — a one-time Product staff are still configuring is a
 * **`draft`** purchase.
 *
 * Stage 1 gave a *recurring* Product its Draft for free (a line of the
 * member's Draft ProductSet). A one-time Product has no such home: its
 * purchase row used to exist only once checkout started (`pending_payment`).
 * The inline Add Product form's **Save** must persist it without paying, and
 * **Cancel** must hard-delete it, so the purchase table gains the one status
 * the ticket names.
 *
 * Only the CHECK moves. `mprod_pending_purchase_key` is UNIQUE over
 * `pending_payment` alone and so ignores a draft by construction (a draft
 * takes no payment request, no Billing Event and no provider call), and
 * `cancelAbandonedPurchases()` selects `pending_payment` rows only, so neither
 * needs a change. `payment_request_id` is already nullable.
 *
 * Cost: `ADD CONSTRAINT … CHECK` is `ALGORITHM=COPY` — it rebuilds the table
 * and blocks concurrent DML, the price 228 paid. The swap is guarded so a
 * re-run after a partial failure touches nothing.
 */

const TABLE = 'member_products_oneoff_snapshot';
const CHECK = 'chk_mprod_status';

/** Mirrors `MEMBER_PRODUCT_STATUSES` in `api/src/domain/memberProductPurchase.ts`. */
const STATUSES = ['pending_payment', 'active', 'cancelled', 'draft'];

/** MySQL: ER_CHECK_CONSTRAINT_NOT_FOUND — the only error a DROP CHECK may swallow. */
const ER_CHECK_CONSTRAINT_NOT_FOUND = 3940;

const checkAllows = async (knex, value) => {
  const rows = await knex.raw(
    `SELECT cc.CHECK_CLAUSE
       FROM information_schema.CHECK_CONSTRAINTS cc
       JOIN information_schema.TABLE_CONSTRAINTS tc
         ON tc.CONSTRAINT_SCHEMA = cc.CONSTRAINT_SCHEMA
        AND tc.CONSTRAINT_NAME = cc.CONSTRAINT_NAME
      WHERE tc.TABLE_SCHEMA = DATABASE()
        AND tc.TABLE_NAME = ?
        AND cc.CONSTRAINT_NAME = ?`,
    [TABLE, CHECK],
  );
  const clause = (rows[0][0]?.CHECK_CLAUSE ?? '').replace(/\\/g, '');
  return clause.includes(`'${value}'`);
};

const setCheck = async (knex, values) => {
  await knex.raw(`ALTER TABLE ${TABLE} DROP CHECK ${CHECK}`).catch((err) => {
    if (err.errno !== ER_CHECK_CONSTRAINT_NOT_FOUND) throw err;
  });
  await knex.raw(
    `ALTER TABLE ${TABLE} ADD CONSTRAINT ${CHECK} CHECK (status IN (${values.map((v) => `'${v}'`).join(', ')}))`,
  );
};

exports.up = async (knex) => {
  if (!(await checkAllows(knex, 'draft'))) await setCheck(knex, STATUSES);
};

exports.down = async (knex) => {
  // A draft has no meaning in the narrow set, so a rollback with drafts on file
  // is refused rather than deleting a staff member's configured purchase.
  const rows = await knex.raw(`SELECT COUNT(*) AS n FROM ${TABLE} WHERE status = 'draft'`);
  if (Number(rows[0][0].n) > 0) return;
  if (await checkAllows(knex, 'draft')) await setCheck(knex, STATUSES.filter((s) => s !== 'draft'));
};

exports.STATUSES = STATUSES;
