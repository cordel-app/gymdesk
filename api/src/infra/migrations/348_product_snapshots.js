/**
 * #2126 stage 1 — the Product assignment snapshot model. Additive only: nothing reads these
 * tables yet, nothing is dropped and `member_products_oneoff_snapshot`,
 * `member_products_recurrent_snapshot` and the Promotion tables are untouched (stages 2-5).
 *
 *   product_session_snapshots      a bought Sessions package (the purchase row whose type is
 *                                  `sessions`), frozen as it was bought.
 *   product_oneoff_snapshots       any other bought one-time Product.
 *   product_periodical_snapshots   a recurring Product line of a Product Set version.
 *   product_promotion_snapshots    a Promotion applied to one of the three: a purchase's
 *                                  Promotion row, or a Product-target application owned by a
 *                                  recurring line. Exactly one parent FK is set (CHECK).
 *   product_promotion_grant_snapshots  the Products a Product-target application grants (the
 *                                  user_membership_promotion_*_snapshot rows).
 *
 * `member_products_oneoff_snapshot` stays the purchase and financial record: a purchase
 * snapshot points at it through `member_product_id`. A purchase belongs to no Product Set, so
 * `product_set_id` is nullable; a recurring line always has one. `member_id` is the purchase's
 * member, or the owner of the line's Product Set. Every table carries `source_id` (UNIQUE), the
 * legacy row it was copied from, which makes `backfillProductSnapshots()` repeatable and keeps
 * traceability. Nothing is fabricated: a value the source does not hold stays NULL, apart from a
 * line's name/type, which the legacy row may lack and is then read from the Product it names.
 * `status` is the source of truth for "is it active" (a purchase keeps its own status; a line
 * takes its Product Set version's). Nothing limits a member to one active row per Product.
 * `down` drops the new tables; the legacy data is untouched so the backfill can be re-run.
 */

const NEW_TABLES = [
  'product_promotion_grant_snapshots',
  'product_promotion_snapshots',
  'product_periodical_snapshots',
  'product_oneoff_snapshots',
  'product_session_snapshots',
];

const STATUSES = "'draft','pending_payment','active','cancelled','superseded'";
const PROMO_ACTIONS = "'no_benefit','waive','percentage_discount','fixed_discount','fixed_price'";

function productTable(name, abbr, extraCols, extraDdl) {
  return `
    CREATE TABLE ${name} (
      id                      INT UNSIGNED  NOT NULL AUTO_INCREMENT,
      gym_id                  CHAR(36)      NOT NULL,
      member_id               INT UNSIGNED  NOT NULL,
      product_set_id          INT UNSIGNED  NULL,
      product_id              INT UNSIGNED  NULL,
      source_id               INT UNSIGNED  NULL,
      status                  VARCHAR(20)   NOT NULL DEFAULT 'draft',
      is_inherited            TINYINT(1)    NOT NULL DEFAULT 0,
      product_name            VARCHAR(255)  NOT NULL,
      product_type            VARCHAR(32)   NULL,
      billing_frequency       VARCHAR(20)   NULL,
      units                   INT UNSIGNED  NULL,
      quantity                INT UNSIGNED  NOT NULL DEFAULT 1,
      currency                VARCHAR(3)    NULL,
      unit_price              DECIMAL(10,2) NULL,
      list_price              DECIMAL(10,2) NULL,
      direct_discount_percent DECIMAL(5,2)  NULL,
      direct_discount_amount  DECIMAL(10,2) NULL,
      tax_rate_percent        DECIMAL(5,2)  NULL,
      starts_at               DATE          NULL,
      ends_at                 DATE          NULL,
      origin                  VARCHAR(16)   NULL,
      ${extraCols}
      created_at              DATETIME      NOT NULL DEFAULT (UTC_TIMESTAMP()),
      created_by              VARCHAR(255)  NULL,
      modified_at             DATETIME      NULL,
      modified_by             VARCHAR(255)  NULL,
      PRIMARY KEY (id),
      UNIQUE KEY ${abbr}_source_key (source_id),
      KEY ${abbr}_member_index (gym_id, member_id, status),
      KEY ${abbr}_set_index (product_set_id),
      KEY ${abbr}_product_index (product_id),
      CONSTRAINT ${abbr}_gym_fk FOREIGN KEY (gym_id) REFERENCES gyms (id) ON DELETE CASCADE,
      CONSTRAINT ${abbr}_member_fk FOREIGN KEY (member_id) REFERENCES members (id) ON DELETE CASCADE,
      CONSTRAINT ${abbr}_set_fk FOREIGN KEY (product_set_id) REFERENCES product_sets (id) ON DELETE CASCADE,
      CONSTRAINT ${abbr}_product_fk FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE SET NULL,
      ${extraDdl}
      CONSTRAINT chk_${abbr}_status CHECK (status IN (${STATUSES})),
      CONSTRAINT chk_${abbr}_quantity CHECK (quantity > 0)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;
}

const PURCHASE_COLS = `
      member_product_id       INT UNSIGNED  NULL,
      purchased_at            DATETIME      NULL,
      validity_days           INT UNSIGNED  NULL,
      valid_until             DATE          NULL,
      cancelled_on            DATE          NULL,`;

function purchaseDdl(abbr) {
  return `
      KEY ${abbr}_purchase_index (member_product_id),
      CONSTRAINT ${abbr}_purchase_fk FOREIGN KEY (member_product_id) REFERENCES member_products_oneoff_snapshot (id) ON DELETE SET NULL,`;
}

async function createTables(knex) {
  if (!(await knex.schema.hasTable('product_session_snapshots'))) {
    await knex.raw(productTable('product_session_snapshots', 'prsess', PURCHASE_COLS, purchaseDdl('prsess')));
  }
  if (!(await knex.schema.hasTable('product_oneoff_snapshots'))) {
    await knex.raw(productTable('product_oneoff_snapshots', 'proneoff', PURCHASE_COLS, purchaseDdl('proneoff')));
  }
  if (!(await knex.schema.hasTable('product_periodical_snapshots'))) {
    await knex.raw(productTable('product_periodical_snapshots', 'prperiod', `
      schedule_id             INT UNSIGNED  NULL,
      line_ref                INT UNSIGNED  NULL,`, `
      KEY prperiod_line_index (product_set_id, line_ref),
      CONSTRAINT prperiod_schedule_fk FOREIGN KEY (schedule_id) REFERENCES product_set_schedules (id) ON DELETE SET NULL,`));
  }
  if (!(await knex.schema.hasTable('product_promotion_snapshots'))) {
    await knex.raw(`
      CREATE TABLE product_promotion_snapshots (
        id                            INT UNSIGNED  NOT NULL AUTO_INCREMENT,
        gym_id                        CHAR(36)      NOT NULL,
        member_id                     INT UNSIGNED  NOT NULL,
        product_session_snapshot_id   INT UNSIGNED  NULL,
        product_oneoff_snapshot_id    INT UNSIGNED  NULL,
        product_periodical_snapshot_id INT UNSIGNED NULL,
        source_purchase_promotion_id  INT UNSIGNED  NULL,
        source_application_id         INT UNSIGNED  NULL,
        promotion_id                  INT UNSIGNED  NOT NULL,
        promotion_name                VARCHAR(255)  NULL,
        status                        VARCHAR(20)   NOT NULL DEFAULT 'applied',
        is_inherited                  TINYINT(1)    NOT NULL DEFAULT 0,
        benefit_action                VARCHAR(30)   NULL,
        benefit_value                 DECIMAL(10,2) NULL,
        duration_cycles               INT UNSIGNED  NULL,
        regular_amount                DECIMAL(10,2) NULL,
        final_amount                  DECIMAL(10,2) NULL,
        snapshot                      JSON          NULL,
        applied_at                    DATETIME      NOT NULL DEFAULT (UTC_TIMESTAMP()),
        applied_by                    VARCHAR(64)   NULL,
        consumed_at                   DATETIME      NULL,
        revoked_at                    DATETIME      NULL,
        created_at                    DATETIME      NOT NULL DEFAULT (UTC_TIMESTAMP()),
        created_by                    VARCHAR(255)  NULL,
        modified_at                   DATETIME      NULL,
        modified_by                   VARCHAR(255)  NULL,
        PRIMARY KEY (id),
        UNIQUE KEY prps_purchase_source_key (source_purchase_promotion_id),
        UNIQUE KEY prps_application_source_key (source_application_id),
        KEY prps_member_index (gym_id, member_id),
        KEY prps_session_index (product_session_snapshot_id),
        KEY prps_oneoff_index (product_oneoff_snapshot_id),
        KEY prps_periodical_index (product_periodical_snapshot_id),
        KEY prps_promotion_index (promotion_id),
        CONSTRAINT prps_gym_fk FOREIGN KEY (gym_id) REFERENCES gyms (id) ON DELETE CASCADE,
        CONSTRAINT prps_member_fk FOREIGN KEY (member_id) REFERENCES members (id) ON DELETE CASCADE,
        CONSTRAINT prps_session_fk FOREIGN KEY (product_session_snapshot_id) REFERENCES product_session_snapshots (id) ON DELETE CASCADE,
        CONSTRAINT prps_oneoff_fk FOREIGN KEY (product_oneoff_snapshot_id) REFERENCES product_oneoff_snapshots (id) ON DELETE CASCADE,
        CONSTRAINT prps_periodical_fk FOREIGN KEY (product_periodical_snapshot_id) REFERENCES product_periodical_snapshots (id) ON DELETE CASCADE,
        CONSTRAINT prps_promotion_fk FOREIGN KEY (promotion_id) REFERENCES promotions (id) ON DELETE RESTRICT,
        CONSTRAINT chk_prps_one_parent CHECK (
          (product_session_snapshot_id IS NOT NULL) + (product_oneoff_snapshot_id IS NOT NULL)
          + (product_periodical_snapshot_id IS NOT NULL) = 1),
        CONSTRAINT chk_prps_status CHECK (status IN ('applied','consumed','revoked','superseded')),
        CONSTRAINT chk_prps_action CHECK (benefit_action IS NULL OR benefit_action IN (${PROMO_ACTIONS}))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  }
  if (!(await knex.schema.hasTable('product_promotion_grant_snapshots'))) {
    await knex.raw(`
      CREATE TABLE product_promotion_grant_snapshots (
        id                           INT UNSIGNED  NOT NULL AUTO_INCREMENT,
        gym_id                       CHAR(36)      NOT NULL,
        product_promotion_snapshot_id INT UNSIGNED NOT NULL,
        grant_kind                   VARCHAR(12)   NOT NULL,
        source_id                    INT UNSIGNED  NULL,
        product_id                   INT UNSIGNED  NULL,
        product_name                 VARCHAR(255)  NOT NULL,
        quantity                     INT UNSIGNED  NOT NULL,
        item_type                    VARCHAR(32)   NULL,
        item_billing_frequency       VARCHAR(20)   NULL,
        unit_price                   DECIMAL(10,2) NULL,
        currency                     VARCHAR(3)    NULL,
        action                       VARCHAR(30)   NOT NULL DEFAULT 'no_benefit',
        value                        DECIMAL(10,2) NULL,
        requirement                  VARCHAR(20)   NOT NULL DEFAULT 'mandatory',
        created_at                   DATETIME      NOT NULL DEFAULT (UTC_TIMESTAMP()),
        PRIMARY KEY (id),
        UNIQUE KEY prpg_source_key (grant_kind, source_id),
        KEY prpg_promotion_index (product_promotion_snapshot_id),
        KEY prpg_gym_index (gym_id),
        KEY prpg_product_index (product_id),
        CONSTRAINT prpg_gym_fk FOREIGN KEY (gym_id) REFERENCES gyms (id) ON DELETE CASCADE,
        CONSTRAINT prpg_promotion_fk FOREIGN KEY (product_promotion_snapshot_id) REFERENCES product_promotion_snapshots (id) ON DELETE CASCADE,
        CONSTRAINT prpg_product_fk FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE SET NULL,
        CONSTRAINT chk_prpg_kind CHECK (grant_kind IN ('session','oneoff','periodical')),
        CONSTRAINT chk_prpg_action CHECK (action IN (${PROMO_ACTIONS})),
        CONSTRAINT chk_prpg_quantity CHECK (quantity > 0),
        CONSTRAINT chk_prpg_requirement CHECK (requirement IN ('mandatory','optional'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  }
}

/**
 * Copies the Product side of the legacy model into the new tables. Repeatable: every insert is
 * guarded by its `source_*` key, so a retry adds nothing and an existing copy is never
 * rewritten. Returns the number of rows inserted per table.
 */
async function backfillProductSnapshots(knex) {
  const run = async (sql) => {
    const [res] = await knex.raw(sql);
    return Number(res.affectedRows || 0);
  };
  const counts = {};

  // Bought one-time Products: a Sessions package and anything else, split on the product type
  // the purchase froze. The purchase row stays the financial record (`member_product_id`).
  for (const [target, typeClause] of [
    ['product_session_snapshots', "mp.product_type = 'sessions'"],
    ['product_oneoff_snapshots', "mp.product_type <> 'sessions'"],
  ]) {
    counts[target] = await run(`
      INSERT INTO ${target}
        (gym_id, member_id, product_set_id, product_id, source_id, status, is_inherited, product_name, product_type,
         billing_frequency, units, quantity, currency, unit_price, list_price, direct_discount_percent,
         direct_discount_amount, tax_rate_percent, origin, member_product_id, purchased_at, validity_days,
         valid_until, cancelled_on, created_at, created_by, modified_at, modified_by)
      SELECT mp.gym_id, mp.member_id, NULL, mp.product_id, mp.id, mp.status, 0, mp.product_name, mp.product_type,
             mp.billing_frequency, mp.units, 1, mp.currency, mp.amount, mp.list_price, mp.direct_discount_percent,
             mp.direct_discount_amount, mp.tax_rate_percent, mp.origin, mp.id, mp.purchased_at, mp.validity_days,
             mp.valid_until, mp.cancelled_on, mp.created_at, mp.created_by, mp.modified_at, mp.modified_by
        FROM member_products_oneoff_snapshot mp
       WHERE ${typeClause}
         AND NOT EXISTS (SELECT 1 FROM ${target} x WHERE x.source_id = mp.id)`);
  }

  // Recurring lines of a Product Set version: the member is the version's owner and the status
  // is the version's. A line the legacy table holds without a version has no home and is left
  // for the validation report.
  counts.product_periodical_snapshots = await run(`
    INSERT INTO product_periodical_snapshots
      (gym_id, member_id, product_set_id, product_id, source_id, status, is_inherited, product_name, product_type,
       billing_frequency, quantity, currency, unit_price, list_price, direct_discount_percent, starts_at, ends_at,
       origin, schedule_id, line_ref, created_at)
    SELECT s.gym_id, ps.owner_member_id, s.product_set_id, s.product_id, s.id, ps.status, s.is_inherited,
           COALESCE(s.item_name, p.name), COALESCE(s.item_type, p.type), s.item_billing_frequency, s.quantity,
           s.currency, s.unit_price, s.list_unit_price, s.direct_discount_percent, s.starts_at, s.ends_at,
           s.origin, s.schedule_id, s.line_ref, s.created_at
      FROM member_products_recurrent_snapshot s
      JOIN product_sets ps ON ps.id = s.product_set_id AND ps.gym_id = s.gym_id
      JOIN products p ON p.id = s.product_id
     WHERE NOT EXISTS (SELECT 1 FROM product_periodical_snapshots x WHERE x.source_id = s.id)`);

  // Promotions applied to a purchase (one row per purchase and Promotion), routed to the
  // snapshot of the table the purchase landed in.
  counts.product_promotion_snapshots = 0;
  for (const [parentCol, parentTable] of [
    ['product_session_snapshot_id', 'product_session_snapshots'],
    ['product_oneoff_snapshot_id', 'product_oneoff_snapshots'],
  ]) {
    counts.product_promotion_snapshots += await run(`
      INSERT INTO product_promotion_snapshots
        (gym_id, member_id, ${parentCol}, source_purchase_promotion_id, promotion_id, promotion_name, status,
         benefit_action, benefit_value, duration_cycles, regular_amount, final_amount, applied_at, created_at)
      SELECT pp.gym_id, par.member_id, par.id, pp.id, pp.promotion_id, pp.promotion_name, 'applied',
             pp.benefit_action, pp.benefit_value, pp.duration_cycles, pp.regular_amount, pp.final_amount,
             pp.applied_at, pp.applied_at
        FROM member_products_oneoff_promotion_snapshot pp
        JOIN ${parentTable} par ON par.source_id = pp.member_product_id AND par.gym_id = pp.gym_id
       WHERE NOT EXISTS (SELECT 1 FROM product_promotion_snapshots x WHERE x.source_purchase_promotion_id = pp.id)`);
  }

  // Product-target applications owned by a recurring line (`recurrent_snapshot_id`). One at the
  // version level only (no owning line) has no parent and is left for the validation report.
  counts.product_promotion_snapshots += await run(`
    INSERT INTO product_promotion_snapshots
      (gym_id, member_id, product_periodical_snapshot_id, source_application_id, promotion_id, promotion_name,
       status, is_inherited, snapshot, applied_at, applied_by, consumed_at, revoked_at, created_at, created_by,
       modified_at, modified_by)
    SELECT ump.gym_id, par.member_id, par.id, ump.id, ump.promotion_id,
           JSON_UNQUOTE(JSON_EXTRACT(ump.snapshot, '$.name')), ump.status, 0, ump.snapshot, ump.applied_at,
           ump.applied_by, ump.consumed_at, ump.revoked_at, ump.applied_at, ump.created_by, ump.modified_at,
           ump.modified_by
      FROM user_membership_promotions ump
      JOIN promotions pr ON pr.id = ump.promotion_id AND pr.applies_to = 'product'
      JOIN product_periodical_snapshots par ON par.source_id = ump.recurrent_snapshot_id AND par.gym_id = ump.gym_id
     WHERE ump.recurrent_snapshot_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM product_promotion_snapshots x WHERE x.source_application_id = ump.id)`);

  counts.product_promotion_grant_snapshots = 0;
  for (const [kind, source] of [
    ['session', 'user_membership_promotion_session_snapshot'],
    ['oneoff', 'user_membership_promotion_oneoff_snapshot'],
    ['periodical', 'user_membership_promotion_periodical_snapshot'],
  ]) {
    counts.product_promotion_grant_snapshots += await run(`
      INSERT INTO product_promotion_grant_snapshots
        (gym_id, product_promotion_snapshot_id, grant_kind, source_id, product_id, product_name, quantity,
         item_type, item_billing_frequency, unit_price, currency, action, value, requirement, created_at)
      SELECT g.gym_id, pp.id, '${kind}', g.id, g.product_id, g.product_name, g.quantity, g.item_type,
             g.item_billing_frequency, g.unit_price, g.currency, g.action, g.value, g.requirement, g.created_at
        FROM ${source} g
        JOIN product_promotion_snapshots pp
          ON pp.source_application_id = g.user_membership_promotion_id AND pp.gym_id = g.gym_id
       WHERE NOT EXISTS (SELECT 1 FROM product_promotion_grant_snapshots x
                          WHERE x.grant_kind = '${kind}' AND x.source_id = g.id)`);
  }
  return counts;
}

exports.backfillProductSnapshots = backfillProductSnapshots;

exports.up = async (knex) => {
  await createTables(knex);
  const counts = await backfillProductSnapshots(knex);
  console.log(`migration 348: product snapshots backfilled ${JSON.stringify(counts)}`);
};

exports.down = async (knex) => {
  for (const table of NEW_TABLES) await knex.schema.dropTableIfExists(table);
};
