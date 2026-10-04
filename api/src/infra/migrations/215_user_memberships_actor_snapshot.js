/**
 * #958 — Assigned Membership Plan cards on the Member page: *Created by* and
 * *Created at* on every card.
 *
 * `created_at` is already a column. Who created the assignment was not: #511
 * derived it from `audit_logs` (the first creation row for
 * `entity_type = 'user_membership'`) in the single-row
 * `GET /user-memberships/:id` only, deliberately kept out of the list reads
 * because it costs a correlated subquery per row. #958 asks for the actor on
 * every card of the Member's MEMBERSHIP PLANS section, and the thread's Q4
 * answer settles how:
 *
 *   > Key metadata (created by, modified by, created at, modified at, deleted by,
 *   > deleted at) should not come from audit. They should be part of the entity
 *   > tables.
 *
 * So the actor is snapshotted at write time, in the immutable-pair shape
 * `tax_rates.created_by_name` (migration 126), `themes.created_by_name` (178),
 * `nutrition_library_items` (196) and `exercises` (208) already use: a display
 * name plus the kind of actor it was, written once by the three paths that insert
 * a `user_memberships` row (`POST /user-memberships`,
 * `POST /user-memberships/:id/assign-new-plan`, `POST /membership-plans/:id/assign`).
 * A *name* rather than a user id because a superadmin acting on a gym directly
 * has no `gym_memberships` row to join to, and because the point of a snapshot is
 * that renaming or removing the staff member later does not rewrite the record of
 * who assigned the plan.
 *
 * ## Only the creation pair
 *
 * `modified_by` is **not** added here, and that is deliberate rather than
 * forgotten: an assignment is modified by things that are not people — the
 * nightly billing run advancing `next_billing_date`, the payment webhook
 * stamping the first one, the dunning escalation pausing it — none of which has
 * an actor to snapshot. `audit_logs` records those with their own `source`, and
 * the Assigned Plan Details modal keeps reading "last modified" from there. The
 * card this ticket redesigns shows *Created by* / *Created at* and nothing else,
 * so widening the principle to the other four fields is a decision with its own
 * writers to find, and its own ticket.
 *
 * ## Backfill: the name, and only the name
 *
 * The existing rows' creators *are* recoverable, exactly and not by guessing:
 * `audit_logs` holds one creation row per assignment with the actor's name
 * snapshotted at the time (migration 055), which is precisely what
 * `loadAuditMetadata()` has been reading. The earliest such row is the creation,
 * and there are **three** actions to look for, one per insert path — `create`,
 * `assign_new_plan` and `assign_plan`, the Plans page's bulk Assign. Missing one
 * would leave every assignment made that way reading `—` for ever with its actor
 * sitting in `audit_logs`, and a shipped migration is never edited.
 *
 * `created_by_type` is left **NULL** for a backfilled row. `audit_logs` cannot
 * say which kind of actor it was: `getTenantContext()` reports `isSuperadmin` for
 * a superadmin acting on a gym, so the live writers really do produce
 * `'superadmin'`, while `sourceForRole()` maps that actor and a gym admin alike
 * to `source = 'admin'`. Writing `'staff'` for all of them would therefore
 * mislabel every assignment a superadmin created on any surface that renders the
 * type (`actorLabel()` in the Taxes card prints `name · Staff`), and that surface
 * already degrades to the bare name when the type is NULL. The card #958 adds
 * shows the name alone, so nothing is lost by declining to invent the other half.
 *
 * Scoped to `created_by_name IS NULL` so it never overwrites what the
 * application wrote and a re-run after a partial failure resumes. Because the
 * statement writes one column, that scope cannot leave a half-written pair —
 * which the `down()`-fails-between-two-DROPs case would otherwise produce.
 *
 * ## No CHECK, no index
 *
 * `ADD CONSTRAINT` rebuilds `user_memberships` under `ALGORITHM=COPY` —
 * migrations 174, 189, 192 and 194 all declined one on this table for that
 * reason and this follows them; `actorSnapshot()` is the one place the pair is
 * produced and it can only answer `'staff'` or `'superadmin'`. Neither column is
 * a predicate anywhere (every reader reaches them through a row it already
 * selected on `gym_id` + `member_id` or on the primary key), so an index would
 * pay for nothing.
 */

const TABLE = 'user_memberships';

/** The creation actor pair, each column added and dropped under its own guard. */
const ACTOR_COLUMNS = [
  { column: 'created_by_name', length: 255 },
  { column: 'created_by_type', length: 20 },
];

/**
 * Every action that `recordAudit()` writes when a `user_memberships` row is
 * created — one per insert path: `POST /user-memberships`,
 * `POST /user-memberships/:id/assign-new-plan` and the Plans page's
 * `POST /membership-plans/:id/assign`. Declared here rather than imported from
 * `api/src/api/user-memberships.ts`, whose own `CREATION_ACTIONS` feeds a
 * `NOT IN` exclusion: the two lists mean different things and a migration must
 * not change meaning when application code does.
 */
const CREATION_ACTIONS = ['create', 'assign_new_plan', 'assign_plan'];

exports.up = async (knex) => {
  // Guarded per column, not per pair: knex's mysql2 dialect batches ADDs into one
  // ALTER but emits a separate ALTER per DROP, so a pair-level guard keyed on
  // `_by_name` would skip a half-dropped pair for ever and make a later `up()`
  // fail with ER_DUP_FIELDNAME on the surviving column (migration 196's note).
  for (const { column, length } of ACTOR_COLUMNS) {
    if (!(await knex.schema.hasColumn(TABLE, column))) {
      await knex.schema.alterTable(TABLE, (t) => { t.string(column, length).nullable(); });
    }
  }

  // See the header: the earliest creation audit row *is* the creation, and its
  // `actor_name` is already a snapshot of the actor's name at the time
  // (migration 055). The `actor_name IS NOT NULL` filter is what keeps a row
  // whose actor was never recorded NULL rather than matched and then blanked.
  //
  // `audit_logs.entity_id` is a VARCHAR, so the id is cast rather than compared
  // across types — and that comparison is pinned to one charset and collation on
  // both sides. A bare `CAST(… AS CHAR)` takes the *connection's* character set
  // and collation while the column has its table's, which is
  // ER_CANT_AGGREGATE_2COLLATIONS ("illegal mix of collations") under mysql2's
  // own handshake; and a `COLLATE utf8mb4_bin` on a cast left to the connection
  // is ER_COLLATION_CHARSET_MISMATCH the moment that connection is not utf8mb4.
  // Naming the charset in the CAST settles both, and binary rather than a named
  // server collation assumes nothing about which one the column was created
  // with: two decimal id strings are equal exactly when their bytes are.
  const auditedCreator = (select) =>
    `SELECT ${select} FROM audit_logs al
      WHERE al.gym_id = um.gym_id
        AND al.entity_type = 'user_membership'
        AND al.entity_id COLLATE utf8mb4_bin
            = CAST(um.id AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_bin
        AND al.action IN (${CREATION_ACTIONS.map(() => '?').join(',')})
        AND al.actor_name IS NOT NULL`;

  await knex.raw(
    `UPDATE ${TABLE} um
     SET um.created_by_name = (${auditedCreator('al.actor_name')}
            ORDER BY al.created_at ASC, al.id ASC LIMIT 1)
     WHERE um.created_by_name IS NULL
       AND EXISTS (${auditedCreator('1')})`,
    [...CREATION_ACTIONS, ...CREATION_ACTIONS],
  );
};

exports.down = async (knex) => {
  for (const { column } of [...ACTOR_COLUMNS].reverse()) {
    if (await knex.schema.hasColumn(TABLE, column)) {
      await knex.schema.alterTable(TABLE, (t) => t.dropColumn(column));
    }
  }
};
