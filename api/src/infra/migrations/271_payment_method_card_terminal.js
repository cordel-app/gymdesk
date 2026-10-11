/**
 * #1459 — `card_terminal`: a front-desk payment taken on an external physical
 * card terminal (datáfono), recorded by staff after the terminal approved it.
 *
 * `payment_requests.method` (migration 247) says how an attempt was made:
 * `provider` | `cash` | `waive`. An external terminal payment is neither cash
 * nor a provider call, so it is a fourth value rather than a `cash` row with a
 * note — reporting must be able to separate the two, and the online provider is
 * never called for it. The new set is a strict superset, so revalidating
 * existing rows cannot fail. Nothing is backfilled.
 *
 * Cost: `ADD CONSTRAINT … CHECK` rebuilds `payment_requests` under
 * ALGORITHM=COPY, LOCK=SHARED (same maintenance window as 216/217/226/270).
 */

const CHECK = 'chk_payment_requests_method';

async function setMethodCheck(knex, values) {
  const [[row]] = await knex.raw(
    `SELECT COUNT(*) AS cnt FROM information_schema.TABLE_CONSTRAINTS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payment_requests' AND CONSTRAINT_NAME = ?`,
    [CHECK],
  );
  const wantsTerminal = values.includes('card_terminal');
  if (row.cnt > 0) {
    const [[has]] = await knex.raw(
      `SELECT COUNT(*) AS cnt FROM information_schema.CHECK_CONSTRAINTS
        WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_NAME = ?
          AND CHECK_CLAUSE LIKE '%card_terminal%'`,
      [CHECK],
    );
    if ((has.cnt > 0) === wantsTerminal) return;
    await knex.raw(`ALTER TABLE payment_requests DROP CHECK ${CHECK}`);
  }
  const list = values.map((v) => `'${v}'`).join(',');
  await knex.raw(`ALTER TABLE payment_requests ADD CONSTRAINT ${CHECK} CHECK (method IN (${list}))`);
}

exports.up = async (knex) => {
  await setMethodCheck(knex, ['provider', 'cash', 'waive', 'card_terminal']);
};

exports.down = async (knex) => {
  // Rows of the dropped value would fail the narrower constraint; they were
  // cash-equivalent settlements, so they fall back to `cash`.
  await knex.raw("UPDATE payment_requests SET method = 'cash' WHERE method = 'card_terminal'");
  await setMethodCheck(knex, ['provider', 'cash', 'waive']);
};
