/**
 * #1108 stage 2 — **Pending Payment**, the second pre-activation status.
 *
 * Stage 1 (migration 227) brought `draft` back and left the second state the
 * ticket names to the Save & Pay transaction that produces it. This is that
 * widening: `pending_payment` sits between a Draft and an Active assignment —
 * the configuration is committed and locked, the payment is being collected,
 * and the row becomes `active` when the provider's webhook (card) or the
 * staff's cash payment (`POST /user-memberships/:id/record-payment`) confirms
 * the money arrived.
 *
 *   draft ──► pending_payment ──► active ◄──► paused
 *     └──────────┴─────────────────┴───────────┴──► cancelled
 *
 * It is 227's device exactly — the stored CHECK's literal set compared as an
 * exact set, so a six-value CHECK from a database where 148's `down` ran is
 * not mistaken for this one; `down` refuses to narrow while a row holds the
 * value, for 198's reason — and it pays `ALGORITHM=COPY` once more, which
 * 227's header already said stage 2 would.
 *
 * `awaiting_payment` (#511) stays retired: it is not this value, nothing
 * writes it, and a CHECK listing it would make a status insertable that no
 * path can ever move on.
 */

/** MySQL: ER_CHECK_CONSTRAINT_NOT_FOUND — the only error a DROP CHECK may swallow. */
const ER_CHECK_CONSTRAINT_NOT_FOUND = 3940;

const STATUS_CHECK = 'user_memberships_status_check';
const NARROW = ['draft', 'active', 'paused', 'cancelled', 'expired'];
const WIDE = ['pending_payment', ...NARROW];

const statusCheckClause = async (knex) => {
  const rows = await knex.raw(
    `SELECT cc.CHECK_CLAUSE
       FROM information_schema.CHECK_CONSTRAINTS cc
       JOIN information_schema.TABLE_CONSTRAINTS tc
         ON tc.CONSTRAINT_SCHEMA = cc.CONSTRAINT_SCHEMA
        AND tc.CONSTRAINT_NAME = cc.CONSTRAINT_NAME
      WHERE tc.TABLE_SCHEMA = DATABASE()
        AND tc.TABLE_NAME = 'user_memberships'
        AND cc.CONSTRAINT_NAME = ?`,
    [STATUS_CHECK],
  );
  const clause = rows[0][0]?.CHECK_CLAUSE;
  return clause == null ? null : clause.replace(/\\/g, '');
};

const statusCheckValues = async (knex) => {
  const clause = await statusCheckClause(knex);
  if (clause == null) return null;
  return [...clause.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
};

const isStatusSet = (current, wanted) => {
  if (current == null) return false;
  const target = [...wanted].sort();
  return current.length === target.length && current.every((v, i) => v === target[i]);
};

const setStatusCheck = async (knex, values) => {
  await knex.raw(`ALTER TABLE user_memberships DROP CHECK ${STATUS_CHECK}`).catch((err) => {
    if (err.errno !== ER_CHECK_CONSTRAINT_NOT_FOUND) throw err;
  });
  await knex.raw(
    `ALTER TABLE user_memberships ADD CONSTRAINT ${STATUS_CHECK} ` +
    `CHECK (status IN (${values.map((v) => `'${v}'`).join(',')}))`,
  );
};

exports.up = async (knex) => {
  if (isStatusSet(await statusCheckValues(knex), WIDE)) return;
  await setStatusCheck(knex, WIDE);
};

exports.down = async (knex) => {
  if (isStatusSet(await statusCheckValues(knex), NARROW)) return;
  const marks = NARROW.map(() => '?').join(',');
  const [counted] = await knex.raw(
    `SELECT COUNT(*) AS n FROM user_memberships WHERE status NOT IN (${marks})`,
    NARROW,
  );
  const total = Number(counted[0]?.n ?? 0);
  if (total > 0) {
    const [sample] = await knex.raw(
      `SELECT id, gym_id, status FROM user_memberships
        WHERE status NOT IN (${marks})
        ORDER BY id LIMIT 20`,
      NARROW,
    );
    const list = sample.map((r) => `#${r.id} (gym ${r.gym_id}, ${r.status})`).join(', ');
    throw new Error(
      `234_pending_payment_status: ${total} user_memberships row(s) hold a status the narrow ` +
      `CHECK would refuse: ${list}${total > sample.length ? ', …' : ''}. Roll the application ` +
      'half back first and move those rows on (activate or cancel them), then retry.',
    );
  }
  await setStatusCheck(knex, NARROW);
};
