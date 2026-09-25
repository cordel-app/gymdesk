/**
 * #635 stage 13 — Billing & Duration becomes the Membership Plan's only
 * billing section, and gains the Pre-paid Duration the thread asked for.
 *
 * The thread's final model (the 24 Sep comment) asks for a Plan that carries
 * Billing & Duration, One-off / Session / Period Benefits and Auto-renew, and
 * nothing else:
 *
 *   > Remove the old: Initial Billing, Recurring Billing, Initial Service,
 *   > Recurring Service fields and migrate all consumers away from them.
 *
 * `billing_policies` (migration 060) holds those four interval/unit pairs plus
 * `auto_renew`. Three of them are read by nothing that bills — the Plans
 * editor is their only consumer — so they are dropped here:
 *
 *   - `initial_billing_interval`  / `initial_billing_unit`
 *   - `initial_service_interval`  / `initial_service_unit`
 *   - `recurring_service_interval`/ `recurring_service_unit`
 *
 * The fourth, `recurring_billing_*`, stays. Free / Paid / Bonus say how *long*
 * a contract runs; they do not say how *often* it charges, and this pair is the
 * only answer to that in the schema (`ASSIGNMENT_CADENCE`, `POST /billing/run`,
 * the Billing Simulation, the Payments dashboard and every assignment's own
 * `user_memberships.recurring_billing_*` snapshot all read it). It is not a
 * second concept alongside Billing & Duration: the editor now presents it
 * *inside* that section as the single **Billing frequency**, exactly as the
 * Assigned Plan's own Billing & Duration section already does (stage 6). So no
 * assignment changes what it is charged or when — dropping the pair would have
 * moved both, which is money this migration has no mandate to move.
 *
 * **Pre-paid Duration** is the new part:
 *
 *   > I'd also like to include the pre-paid duration which will flag in the
 *   > simulation as pre-paid - no charge
 *
 * A Promotion has carried `pay_beforehand_months` since migration 141 — how
 * many of its `paid_months` are already paid up front, drawn as "Prepaid
 * (promotion)" rather than "Pay (promotion)". This gives the Plan the same
 * column, with the same meaning and the same 0..paid_months bound, so §7's
 * "the same semantics as the Promotion configuration" holds for the fourth
 * field too, and the assignment gets its own frozen copy of it (§11: the
 * snapshot owns everything that decides what the assignment bills — a Plan
 * edited later must not reach an assignment that already exists).
 *
 * Nullable on both tables, like the free/paid/bonus trio beside it: "never
 * configured" has to stay distinguishable from an explicit 0, and a NULL
 * column means no existing Plan or assignment changes what it bills until
 * someone fills the field in. (The Promotion column is NOT NULL DEFAULT 0
 * because it was added to a table whose duration columns are also NOT NULL.)
 *
 * The 0..paid_months bound is a **same-row** rule, so `membership_plans` gets a
 * CHECK for it rather than trusting the router alone. `user_memberships`
 * deliberately does not: migration 174 refused to add one to that table because
 * `ADD CONSTRAINT` rebuilds it under `ALGORITHM=COPY`, and it is the busiest
 * table in the schema. Its bound is enforced by `PUT
 * /user-memberships/:id/billing-duration` (inside the transaction, so a
 * just-materialised snapshot rolls back with a rejected edit), and
 * `toPlanDuration()` clamps whatever it reads, so a row that somehow carried
 * more pre-paid months than paid ones would still bill correctly.
 *
 * Each column add is guarded by its own `hasColumn` — they are separate
 * non-transactional DDL statements, so a crash between two of them must leave
 * a re-run able to finish the rest (migrations 173/174 for precedent) — while
 * the six drops are one logical change to one small table and go in a single
 * `ALTER`, naming only the columns still present, which is both cheaper (one
 * rebuild, not six) and strictly more atomic. The column adds use knex's own
 * `alterTable`, exactly as migration 174's `user_memberships` adds did, so
 * neither migration is the one that introduces a different algorithm to that
 * table.
 *
 * `down()` is deliberately **lossy**: the three dropped pairs were
 * staff-entered configuration, and it restores them at migration 060's
 * defaults (1 month each) rather than at what they held. Nothing bills off
 * them, so nothing a member is charged is affected either way — but a rollback
 * does present a default as if it had been configured, which is why
 * `docs/go-to-production.md` carries the "capture `SELECT * FROM
 * billing_policies` first" item.
 */

const DROPPED_BILLING_POLICY_COLUMNS = {
  initial_billing_interval: (t) => t.integer('initial_billing_interval').unsigned().notNullable().defaultTo(1),
  initial_billing_unit: (t) => t.enum('initial_billing_unit', ['day', 'week', 'month', 'year']).notNullable().defaultTo('month'),
  initial_service_interval: (t) => t.integer('initial_service_interval').unsigned().notNullable().defaultTo(1),
  initial_service_unit: (t) => t.enum('initial_service_unit', ['day', 'week', 'month', 'year']).notNullable().defaultTo('month'),
  recurring_service_interval: (t) => t.integer('recurring_service_interval').unsigned().notNullable().defaultTo(1),
  recurring_service_unit: (t) => t.enum('recurring_service_unit', ['day', 'week', 'month', 'year']).notNullable().defaultTo('month'),
};

// The Plan's own column sits beside the duration trio it belongs to; the
// assignment's snapshot column has no `after` because migration 174 appended
// its snapshot columns to the end of `user_memberships` in the same way.
const PREPAID_COLUMNS = [
  ['membership_plans', (t) => t.integer('pay_beforehand_months').unsigned().nullable().after('paid_months')],
  ['user_memberships', (t) => t.integer('pay_beforehand_months').unsigned().nullable()],
];

const PREPAID_CHECK = 'chk_membership_plans_pay_beforehand_months';

async function constraintExists(knex, table, name) {
  const [[row]] = await knex.raw(
    `SELECT COUNT(*) AS cnt FROM information_schema.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ?`,
    [table, name],
  );
  return row.cnt > 0;
}

exports.up = async (knex) => {
  // ── 1. Pre-paid Duration on the Plan and on the assignment's snapshot ─────
  for (const [table, add] of PREPAID_COLUMNS) {
    if (!(await knex.schema.hasColumn(table, 'pay_beforehand_months'))) {
      await knex.schema.alterTable(table, add);
    }
  }

  // Guarded on its own: ADD COLUMN and ADD CONSTRAINT are separate
  // non-transactional statements, so a crash between them must not leave a
  // re-run skipping the CHECK. Every existing row has a NULL pre-paid column,
  // so nothing can fail it.
  if (!(await constraintExists(knex, 'membership_plans', PREPAID_CHECK))) {
    await knex.raw(
      `ALTER TABLE membership_plans ADD CONSTRAINT ${PREPAID_CHECK}
       CHECK (pay_beforehand_months IS NULL OR pay_beforehand_months <= COALESCE(paid_months, 0))`,
    );
  }

  // ── 2. The three pairs nothing bills off ─────────────────────────────────
  const present = [];
  for (const column of Object.keys(DROPPED_BILLING_POLICY_COLUMNS)) {
    if (await knex.schema.hasColumn('billing_policies', column)) present.push(column);
  }
  if (present.length > 0) {
    await knex.raw(`ALTER TABLE billing_policies ${present.map((c) => `DROP COLUMN \`${c}\``).join(', ')}`);
  }
};

exports.down = async (knex) => {
  // The restored columns come back at their migration-060 definitions, which
  // are NOT NULL with defaults — so existing rows are valid immediately. The
  // values themselves are gone: nothing read them, so nothing can miss them.
  for (const [column, add] of Object.entries(DROPPED_BILLING_POLICY_COLUMNS)) {
    if (!(await knex.schema.hasColumn('billing_policies', column))) {
      await knex.schema.alterTable('billing_policies', add);
    }
  }

  // The CHECK goes before the column it constrains.
  if (await constraintExists(knex, 'membership_plans', PREPAID_CHECK)) {
    await knex.raw(`ALTER TABLE membership_plans DROP CHECK ${PREPAID_CHECK}`);
  }

  for (const [table] of PREPAID_COLUMNS) {
    if (await knex.schema.hasColumn(table, 'pay_beforehand_months')) {
      await knex.schema.alterTable(table, (t) => t.dropColumn('pay_beforehand_months'));
    }
  }
};
