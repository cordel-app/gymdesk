/**
 * #1991 stage 2: `superseded` joins the Assigned Plan and Plan Promotion
 * application lifecycles. An assignment replaced by a successor (the #956
 * replacement and a successor ProductSet version) is `superseded` rather than
 * `cancelled`, and its standing applications move with it, so "the member
 * ended it" and "a newer plan took over" are different facts. Readers that
 * treat `cancelled` as history treat `superseded` the same way.
 *
 * Widening never fails on existing rows; the `down` refuses while a row holds
 * the new value, since mapping it back to `cancelled` is the operator's call.
 */
const ER_CHECK_CONSTRAINT_NOT_FOUND = 3940;

const TABLES = [
  { table: 'user_memberships', check: 'user_memberships_status_check',
    narrow: ['draft', 'pending_payment', 'active', 'paused', 'cancelled', 'expired'] },
  { table: 'user_membership_promotions', check: 'ump_status_check',
    narrow: ['applied', 'consumed', 'revoked'] },
];

const setCheck = async (knex, { table, check }, values) => {
  await knex.raw(`ALTER TABLE ${table} DROP CHECK ${check}`).catch((err) => {
    if (err.errno !== ER_CHECK_CONSTRAINT_NOT_FOUND) throw err;
  });
  await knex.raw(
    `ALTER TABLE ${table} ADD CONSTRAINT ${check} CHECK (status IN (${values.map((v) => `'${v}'`).join(',')}))`,
  );
};

exports.up = async (knex) => {
  for (const t of TABLES) await setCheck(knex, t, [...t.narrow, 'superseded']);
};

exports.down = async (knex) => {
  for (const t of TABLES) {
    const [rows] = await knex.raw(`SELECT COUNT(*) AS n FROM ${t.table} WHERE status = 'superseded'`);
    if (Number(rows[0]?.n ?? 0) > 0) {
      throw new Error(
        `328_superseded_status: ${rows[0].n} ${t.table} row(s) are 'superseded'. Resolve them by SQL ` +
        `(cancelled for an assignment, revoked for an application) and re-run. Nothing has been touched.`,
      );
    }
  }
  for (const t of TABLES) await setCheck(knex, t, t.narrow);
};
