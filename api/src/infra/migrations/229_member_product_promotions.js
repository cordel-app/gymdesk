/**
 * #1118 — **the Promotion a member applied to a Product they bought**:
 * `member_product_promotions`, the immutable snapshot §7 asks for.
 *
 * ── Why a table and not columns on `member_products` ───────────────────────
 *
 * It is the sibling of `user_membership_promotion_{session,oneoff,periodical}_
 * snapshot` (migrations 156/174/203), and for the same reason: #635 §16's rule
 * is that an application prices and displays from its *own* snapshot and never
 * from a live join, and the established shape for that here is a row beside the
 * thing it was applied to. Six nullable columns bolted onto `member_products`
 * would say the same thing less clearly and would have to be read as "is this
 * one set? then they all are".
 *
 * `UNIQUE (member_product_id)` is the load-bearing half: **at most one
 * Promotion per purchase**. §4/§5/§13 all speak of *the* Promotion on a Product
 * — one offer applied, one final price, one snapshot shown — so the rule is the
 * database's rather than the route's, and a second application cannot be
 * stacked onto a purchase by a retry, a second tab or a later caller. It is a
 * table rather than a column pair chiefly so that a stacking rule, if one is
 * ever decided, is a change to this index instead of a new table.
 *
 * ── What is frozen, and what is a link ────────────────────────────────────
 *
 * `promotion_id` is the link to the live Promotion — "which Promotion was
 * this?" — and everything beside it is what was applied: the name as it read
 * then, the `(action, value)` pair (#896, the one vocabulary), the duration in
 * billing cycles (#1135: a **periodical** grant's quantity *is* a Duration; a
 * one-off grant has none, which is the thread's `Q5`, so the column is
 * nullable), and both amounts — the Product's regular VAT-inclusive price and
 * the price the member was actually charged. §7 asks for "relevant
 * price/discount information needed to reproduce the applied pricing" and §13
 * quotes *Price* beside *Final price*, so storing only the discount would make
 * the Admin re-derive the regular price from a catalogue that may have moved.
 *
 * The FK to `promotions` is **RESTRICT**, matching `mprod_product_fk`: the row
 * records money that moved under that Promotion, so the live row may not be
 * hard-deleted out from under it. A Promotion's own removal is a soft delete
 * (`lifecycle_status = 'deleted'`, #900's vocabulary) and leaves every
 * application exactly as it is — which is §7's "the original Promotion may
 * subsequently be edited, renamed, disabled or deleted; none of these may
 * modify the already-applied snapshot".
 *
 * `member_product_id` is **CASCADE**: a purchase and its Promotion are one
 * record, so the snapshot has no meaning once the purchase is gone (and
 * `cleanupTestGyms` deletes the member before the products).
 *
 * ── The two CHECKs ────────────────────────────────────────────────────────
 *
 * `chk_<prefix>_action` and `chk_<prefix>_value` mirror migration 203's Promotion-side
 * pair exactly — same five actions, same value rule — because this is the same
 * vocabulary read in the same context. A new action therefore still goes in the
 * three places #896 names, plus this CHECK, exactly as the other six snapshot
 * tables already require.
 *
 * `chk_<prefix>_amounts` is this table's own: both amounts are non-negative, and
 * the final one may not exceed the regular one — every action in the vocabulary
 * either leaves the price alone or lowers it (`applyLineBenefit()` floors at 0),
 * so a snapshot claiming the member paid *more* than the regular price records
 * something no code path can produce.
 *
 * It is deliberately a **superset** of what the one writer can produce, and so
 * is the action CHECK. `loadPromotionOffers()` offers only
 * `0 < final < regular` and drops `no_benefit` before that, so four states these
 * CHECKs permit — `final = regular`, `final = 0`, `regular = 0` and
 * `no_benefit` — are states no legitimate application holds today. Both are left
 * wide on purpose, for two different reasons: tightening the amounts to
 * `final > 0` would foreclose the "grant a Product for free from the Members
 * App" path the loader's own comment says needs its own ticket, and narrowing
 * the actions would break the exact mirror of migration 203's Promotion-side
 * pair that the whole `(action, value)` vocabulary rests on (and would leave
 * `chk_<prefix>_value`'s own `no_benefit` branch dead). The narrow rule lives in
 * the loader, where it can change without an `ALTER`; these state the bound a
 * stored row may never cross.
 *
 * Cost: one `CREATE TABLE`, so there is nothing to rebuild and no concurrent
 * DML to plan around — unlike migration 228 beside it, whose `ADD CONSTRAINT`
 * on `payment_requests` was `ALGORITHM=COPY`. MySQL commits DDL implicitly, so
 * the single statement stands on its own and a re-run after a partial failure
 * touches nothing.
 */

const TABLE = 'member_product_promotions';

/**
 * The prefix every constraint and index on the table is named with. CHECK and
 * FK names are schema-global in MySQL 8 rather than table-scoped, which is why
 * migrations 212, 224 and 228 prefix their own.
 *
 * `mprodp` rather than the obvious `mpp`: `membership_plan_prices` already
 * names an index `mpp_plan_valid_from_index` (migration 005). Index names are
 * table-scoped so there is no collision today, but the whole reason to prefix
 * is that a CHECK or an FK is not — so a future `chk_mpp_*` on that table would
 * be exactly what the convention exists to avoid. It reads beside 228's own
 * `mprod`, which is the table this one hangs off.
 */
const PREFIX = 'mprodp';

/**
 * Mirrors `PROMOTION_ITEM_ACTIONS` in
 * `api/src/domain/productBenefitActions.ts` — the Promotion's own option set,
 * which is the context an application is read in. Asserted against the module
 * by `api/src/test/member-product-promotions.unit.test.ts`.
 */
const ACTIONS = ['no_benefit', 'waive', 'percentage_discount', 'fixed_discount', 'fixed_price'];

/**
 * Migration 203's value rule, restated for this table's own column names: an
 * action that takes no value must not carry one, a percentage is 0..100 and an
 * amount is non-negative.
 */
function valueCheckExpression() {
  return [
    "(`benefit_action` IN ('no_benefit', 'waive') AND `benefit_value` IS NULL)",
    "(`benefit_action` = 'percentage_discount' AND `benefit_value` IS NOT NULL"
      + ' AND `benefit_value` >= 0 AND `benefit_value` <= 100)',
    "(`benefit_action` IN ('fixed_discount', 'fixed_price') AND `benefit_value` IS NOT NULL"
      + ' AND `benefit_value` >= 0)',
  ].join(' OR ');
}

exports.up = async (knex) => {
  if (await knex.schema.hasTable(TABLE)) return;

  await knex.raw(`
    CREATE TABLE ${TABLE} (
      id                 INT UNSIGNED  NOT NULL AUTO_INCREMENT,
      gym_id             CHAR(36)      NOT NULL,
      member_product_id  INT UNSIGNED  NOT NULL,
      -- The link: which Promotion was this? Everything below is what it said
      -- at the moment it was applied.
      promotion_id       INT UNSIGNED  NOT NULL,
      promotion_name     VARCHAR(255)  NOT NULL,
      benefit_action     VARCHAR(30)   NOT NULL,
      benefit_value      DECIMAL(10,2) NULL,
      -- #1135/§6: the billing cycles a Periodic grant covers. NULL for a
      -- one-off or session grant, which has no cycles to express (the thread's
      -- \`Q5\`) — and never 0, which would read as "covers nothing".
      duration_cycles    INT UNSIGNED  NULL,
      -- Both VAT-inclusive, like \`member_products.amount\` beside them: the
      -- member is quoted one figure (#1121 §3, #817).
      regular_amount     DECIMAL(10,2) NOT NULL,
      final_amount       DECIMAL(10,2) NOT NULL,
      applied_at         DATETIME      NOT NULL DEFAULT (UTC_TIMESTAMP()),
      PRIMARY KEY (id),
      -- §4/§5/§13 speak of *the* Promotion on a Product: one application per
      -- purchase, enforced where the route cannot be raced.
      UNIQUE KEY ${PREFIX}_purchase_key (member_product_id),
      -- "Which purchases used this Promotion?" — §15's audit question, and the
      -- only read that does not start from a purchase.
      KEY ${PREFIX}_promotion_index (gym_id, promotion_id),
      -- Declared rather than left to InnoDB, which would auto-create one named
      -- after the constraint: the index above leads with \`gym_id\`
      -- (migration 228's convention).
      KEY ${PREFIX}_promotion_fk_index (promotion_id),
      CONSTRAINT ${PREFIX}_gym_fk FOREIGN KEY (gym_id)
        REFERENCES gyms(id) ON DELETE CASCADE,
      CONSTRAINT ${PREFIX}_purchase_fk FOREIGN KEY (member_product_id)
        REFERENCES member_products(id) ON DELETE CASCADE,
      CONSTRAINT ${PREFIX}_promotion_fk FOREIGN KEY (promotion_id)
        REFERENCES promotions(id) ON DELETE RESTRICT,
      CONSTRAINT chk_${PREFIX}_action CHECK (benefit_action IN (${ACTIONS.map((a) => `'${a}'`).join(', ')})),
      CONSTRAINT chk_${PREFIX}_value CHECK (${valueCheckExpression()}),
      CONSTRAINT chk_${PREFIX}_duration CHECK (duration_cycles IS NULL OR duration_cycles > 0),
      CONSTRAINT chk_${PREFIX}_amounts CHECK (
        regular_amount >= 0 AND final_amount >= 0 AND final_amount <= regular_amount
      )
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);
};

exports.down = async (knex) => {
  // The record of what a member was charged under: dropped only while it holds
  // nothing, exactly as migration 228 refuses to drop `member_products` while
  // purchases exist.
  if (await knex.schema.hasTable(TABLE)) {
    const rows = await knex.raw(`SELECT COUNT(*) AS n FROM ${TABLE}`);
    if (Number(rows[0][0].n) > 0) return;
  }
  await knex.schema.dropTableIfExists(TABLE);
};

exports.TABLE = TABLE;
exports.PREFIX = PREFIX;
exports.ACTIONS = ACTIONS;
