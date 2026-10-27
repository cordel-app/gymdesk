/**
 * #2125 stage 1 — the Membership Plan assignment snapshot model. Additive only: nothing reads
 * these tables yet, nothing is dropped and `user_memberships`, `product_set_members` and the
 * legacy child tables are untouched (stages 2-5).
 *
 *   plan_snapshots                          one row per Membership Plan assignment of one
 *                                           Product Set version (= one billing obligation).
 *                                           `member_id` is the owner-side member, not
 *                                           necessarily a beneficiary. `status` is the source
 *                                           of truth for "is it active" and needs no join to
 *                                           product_sets. `is_inherited` is provenance, not
 *                                           lifecycle. No UNIQUE on product_set_id alone and
 *                                           none that limits a member to one active plan.
 *   plan_snapshot_beneficiaries             who a snapshot covers (owner included). Keyed by the
 *                                           snapshot, so it is not `product_set_members`.
 *   plan_session_snapshots                  Products included in the plan, one table per
 *   plan_oneoff_snapshots                   type (same columns as user_membership_session /
 *   plan_periodical_snapshots               _oneoff / _periodical), keyed by plan_snapshot_id.
 *   plan_promotion_snapshots                a Membership Plan Promotion application (the
 *                                           user_membership_promotions row, plan targets only).
 *   plan_promotion_{session,oneoff,         the Products the application grants (the
 *     periodical}_product_snapshots         user_membership_promotion_*_snapshot rows).
 *
 * Each table carries `source_id`, the legacy row it was copied from (UNIQUE), which is what
 * makes `backfillPlanSnapshots()` repeatable and keeps traceability. The "one standing application
 * per snapshot and Promotion" rule is only an index here (`standing_key`): the legacy key was per version, so
 * the backfill could land two on one snapshot; stage 2 adds the UNIQUE once the gaps are checked.
 * Beneficiaries copy the chain's *current* coverage ("coverage follows the chain"), not a historical one. Standalone Product
 * purchases and Product-target Promotion applications are out of scope and never copied.
 * `down` drops the new tables; the legacy data is untouched so the backfill can be re-run.
 */

const NEW_TABLES = [
  'plan_promotion_periodical_product_snapshots',
  'plan_promotion_oneoff_product_snapshots',
  'plan_promotion_session_product_snapshots',
  'plan_promotion_snapshots',
  'plan_periodical_snapshots',
  'plan_oneoff_snapshots',
  'plan_session_snapshots',
  'plan_snapshot_beneficiaries',
  'plan_snapshots',
];

const ACTIONS = "'no_benefit','waive','percentage_discount'";
const PROMO_ACTIONS = "'no_benefit','waive','percentage_discount','fixed_discount','fixed_price'";
const ITEM_FREQ = "'once','per_session','four_weeks','week','month','year'";
const ITEM_TYPES = "'fee','service','sessions','merchandise','other'";

function includedProductTable(name, abbr, extraCols, extraDdl) {
  return `
    CREATE TABLE ${name} (
      id                     INT UNSIGNED  NOT NULL AUTO_INCREMENT,
      gym_id                 CHAR(36)      NOT NULL,
      plan_snapshot_id       INT UNSIGNED  NOT NULL,
      source_id              INT UNSIGNED  NULL,
      product_id             INT UNSIGNED  NOT NULL,
      quantity               INT UNSIGNED  NOT NULL DEFAULT 1,
      item_name              VARCHAR(255)  NOT NULL,
      item_type              VARCHAR(32)   NOT NULL,
      unit_price             DECIMAL(10,2) NOT NULL DEFAULT 0.00,
      item_billing_frequency VARCHAR(20)   NULL,
      currency               VARCHAR(3)    NULL,
      action                 VARCHAR(30)   NOT NULL DEFAULT 'no_benefit',
      value                  DECIMAL(10,2) NULL,
      mandatory              TINYINT(1)    NOT NULL DEFAULT 1,
      ${extraCols}
      created_at             DATETIME      NOT NULL DEFAULT (UTC_TIMESTAMP()),
      PRIMARY KEY (id),
      UNIQUE KEY ${abbr}_source_key (source_id),
      UNIQUE KEY ${abbr}_snapshot_product_key (plan_snapshot_id, product_id),
      KEY ${abbr}_gym_index (gym_id),
      KEY ${abbr}_product_index (product_id),
      CONSTRAINT ${abbr}_gym_fk FOREIGN KEY (gym_id) REFERENCES gyms (id) ON DELETE CASCADE,
      CONSTRAINT ${abbr}_snapshot_fk FOREIGN KEY (plan_snapshot_id) REFERENCES plan_snapshots (id) ON DELETE CASCADE,
      CONSTRAINT ${abbr}_product_fk FOREIGN KEY (product_id) REFERENCES products (id),
      ${extraDdl}
      CONSTRAINT chk_${abbr}_action CHECK (action IN (${ACTIONS})),
      CONSTRAINT chk_${abbr}_quantity CHECK (quantity > 0),
      CONSTRAINT chk_${abbr}_item_type CHECK (item_type IN (${ITEM_TYPES})),
      CONSTRAINT chk_${abbr}_item_frequency CHECK (item_billing_frequency IS NULL OR item_billing_frequency IN (${ITEM_FREQ})),
      CONSTRAINT chk_${abbr}_value CHECK (
        (action IN ('no_benefit','waive') AND value IS NULL)
        OR (action = 'percentage_discount' AND value IS NOT NULL AND value >= 0 AND value <= 100))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;
}

function promotionProductTable(name, abbr) {
  return `
    CREATE TABLE ${name} (
      id                          INT UNSIGNED  NOT NULL AUTO_INCREMENT,
      gym_id                      CHAR(36)      NOT NULL,
      plan_promotion_snapshot_id  INT UNSIGNED  NOT NULL,
      source_id                   INT UNSIGNED  NULL,
      product_id                  INT UNSIGNED  NULL,
      product_name                VARCHAR(255)  NOT NULL,
      quantity                    INT UNSIGNED  NOT NULL,
      item_type                   VARCHAR(32)   NULL,
      item_billing_frequency      VARCHAR(20)   NULL,
      unit_price                  DECIMAL(10,2) NULL,
      currency                    VARCHAR(3)    NULL,
      action                      VARCHAR(30)   NOT NULL DEFAULT 'no_benefit',
      value                       DECIMAL(10,2) NULL,
      requirement                 VARCHAR(20)   NOT NULL DEFAULT 'mandatory',
      created_at                  DATETIME      NOT NULL DEFAULT (UTC_TIMESTAMP()),
      PRIMARY KEY (id),
      UNIQUE KEY ${abbr}_source_key (source_id),
      KEY ${abbr}_promotion_index (plan_promotion_snapshot_id),
      KEY ${abbr}_gym_index (gym_id),
      KEY ${abbr}_product_index (product_id),
      CONSTRAINT ${abbr}_gym_fk FOREIGN KEY (gym_id) REFERENCES gyms (id) ON DELETE CASCADE,
      CONSTRAINT ${abbr}_promotion_fk FOREIGN KEY (plan_promotion_snapshot_id) REFERENCES plan_promotion_snapshots (id) ON DELETE CASCADE,
      CONSTRAINT ${abbr}_product_fk FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE SET NULL,
      CONSTRAINT chk_${abbr}_action CHECK (action IN (${PROMO_ACTIONS})),
      CONSTRAINT chk_${abbr}_quantity CHECK (quantity > 0),
      CONSTRAINT chk_${abbr}_requirement CHECK (requirement IN ('mandatory','optional')),
      CONSTRAINT chk_${abbr}_value CHECK (
        (action IN ('no_benefit','waive') AND value IS NULL)
        OR (action = 'percentage_discount' AND value IS NOT NULL AND value >= 0 AND value <= 100)
        OR (action IN ('fixed_discount','fixed_price') AND value IS NOT NULL AND value >= 0))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;
}

async function createTables(knex) {
  if (!(await knex.schema.hasTable('plan_snapshots'))) {
    await knex.raw(`
      CREATE TABLE plan_snapshots (
        id                          INT UNSIGNED  NOT NULL AUTO_INCREMENT,
        gym_id                      CHAR(36)      NOT NULL,
        product_set_id              INT UNSIGNED  NOT NULL,
        member_id                   INT UNSIGNED  NOT NULL,
        membership_plan_id          INT UNSIGNED  NULL,
        status                      VARCHAR(20)   NOT NULL DEFAULT 'draft',
        is_inherited                TINYINT(1)    NOT NULL DEFAULT 0,
        starts_at                   DATE          NOT NULL,
        ends_at                     DATE          NULL,
        closed_at                   DATETIME      NULL,
        schedule_id                 INT UNSIGNED  NULL,
        plan_price_id               INT UNSIGNED  NULL,
        base_price                  DECIMAL(10,2) NULL,
        discount_reason             TEXT          NULL,
        discount_expires_at         DATE          NULL,
        membership_fee_price        DECIMAL(10,2) NULL,
        free_periods                INT UNSIGNED  NULL,
        paid_periods                INT UNSIGNED  NULL,
        bonus_periods               INT UNSIGNED  NULL,
        pay_beforehand_periods      INT UNSIGNED  NULL,
        personal_fee_benefit_action VARCHAR(30)   NOT NULL DEFAULT 'no_benefit',
        personal_fee_benefit_value  DECIMAL(10,2) NULL,
        auto_renew                  TINYINT(1)    NOT NULL DEFAULT 0,
        recurring_billing_interval  INT UNSIGNED  NULL,
        recurring_billing_unit      VARCHAR(10)   NULL,
        origin                      VARCHAR(16)   NULL,
        source_plan_snapshot_id     INT UNSIGNED  NULL,
        source_user_membership_id   INT UNSIGNED  NULL,
        created_at                  DATETIME      NOT NULL DEFAULT (UTC_TIMESTAMP()),
        created_by                  VARCHAR(255)  NULL,
        modified_at                 DATETIME      NULL,
        modified_by                 VARCHAR(255)  NULL,
        PRIMARY KEY (id),
        UNIQUE KEY plan_snapshots_source_key (source_plan_snapshot_id),
        KEY plan_snapshots_status_index (gym_id, status),
        KEY plan_snapshots_member_index (member_id, status),
        KEY plan_snapshots_set_index (product_set_id),
        KEY plan_snapshots_plan_index (membership_plan_id),
        KEY plan_snapshots_um_index (source_user_membership_id),
        CONSTRAINT plan_snapshots_gym_fk FOREIGN KEY (gym_id) REFERENCES gyms (id) ON DELETE CASCADE,
        CONSTRAINT plan_snapshots_set_fk FOREIGN KEY (product_set_id) REFERENCES product_sets (id) ON DELETE CASCADE,
        CONSTRAINT plan_snapshots_member_fk FOREIGN KEY (member_id) REFERENCES members (id) ON DELETE RESTRICT,
        CONSTRAINT plan_snapshots_plan_fk FOREIGN KEY (membership_plan_id) REFERENCES membership_plans (id) ON DELETE RESTRICT,
        CONSTRAINT plan_snapshots_schedule_fk FOREIGN KEY (schedule_id) REFERENCES product_set_schedules (id) ON DELETE SET NULL,
        CONSTRAINT plan_snapshots_price_fk FOREIGN KEY (plan_price_id) REFERENCES membership_plan_prices (id) ON DELETE SET NULL,
        CONSTRAINT chk_plan_snapshots_status CHECK (status IN
          ('draft','pending_payment','active','paused','cancelled','expired','superseded'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  }
  if (!(await knex.schema.hasTable('plan_snapshot_beneficiaries'))) {
    await knex.raw(`
      CREATE TABLE plan_snapshot_beneficiaries (
        id               INT UNSIGNED NOT NULL AUTO_INCREMENT,
        gym_id           CHAR(36)     NOT NULL,
        plan_snapshot_id INT UNSIGNED NOT NULL,
        member_id        INT UNSIGNED NOT NULL,
        is_owner         TINYINT(1)   NOT NULL DEFAULT 0,
        created_at       DATETIME     NOT NULL DEFAULT (UTC_TIMESTAMP()),
        PRIMARY KEY (id),
        UNIQUE KEY psb_snapshot_member_key (plan_snapshot_id, member_id),
        KEY psb_member_index (member_id),
        KEY psb_gym_index (gym_id),
        CONSTRAINT psb_gym_fk FOREIGN KEY (gym_id) REFERENCES gyms (id) ON DELETE CASCADE,
        CONSTRAINT psb_snapshot_fk FOREIGN KEY (plan_snapshot_id) REFERENCES plan_snapshots (id) ON DELETE CASCADE,
        CONSTRAINT psb_member_fk FOREIGN KEY (member_id) REFERENCES members (id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  }
  if (!(await knex.schema.hasTable('plan_session_snapshots'))) {
    await knex.raw(includedProductTable('plan_session_snapshots', 'plsess', 'frequency VARCHAR(20) NULL,', `
      CONSTRAINT chk_plsess_frequency CHECK (frequency IS NULL OR frequency IN ('once','week','four_weeks','month','year')),`));
  }
  if (!(await knex.schema.hasTable('plan_oneoff_snapshots'))) {
    await knex.raw(includedProductTable('plan_oneoff_snapshots', 'ploneoff', '', ''));
  }
  if (!(await knex.schema.hasTable('plan_periodical_snapshots'))) {
    await knex.raw(includedProductTable('plan_periodical_snapshots', 'plperiod', 'schedule_id INT UNSIGNED NULL,', `
      CONSTRAINT plperiod_schedule_fk FOREIGN KEY (schedule_id) REFERENCES product_set_schedules (id) ON DELETE SET NULL,`));
  }
  if (!(await knex.schema.hasTable('plan_promotion_snapshots'))) {
    await knex.raw(`
      CREATE TABLE plan_promotion_snapshots (
        id               INT UNSIGNED NOT NULL AUTO_INCREMENT,
        gym_id           CHAR(36)     NOT NULL,
        plan_snapshot_id INT UNSIGNED NOT NULL,
        source_id        INT UNSIGNED NULL,
        promotion_id     INT UNSIGNED NOT NULL,
        status           VARCHAR(20)  NOT NULL DEFAULT 'applied',
        is_inherited     TINYINT(1)   NOT NULL DEFAULT 0,
        snapshot         JSON         NULL,
        applied_at       DATETIME     NOT NULL DEFAULT (UTC_TIMESTAMP()),
        applied_by       VARCHAR(64)  NULL,
        consumed_at      DATETIME     NULL,
        revoked_at       DATETIME     NULL,
        created_at       DATETIME     NOT NULL DEFAULT (UTC_TIMESTAMP()),
        created_by       VARCHAR(255) NULL,
        modified_at      DATETIME     NULL,
        modified_by      VARCHAR(255) NULL,
        standing_key     VARCHAR(40)  GENERATED ALWAYS AS (
                           IF(status = 'applied', CONCAT(plan_snapshot_id, ':', promotion_id), NULL)) VIRTUAL,
        PRIMARY KEY (id),
        UNIQUE KEY pps_promo_source_key (source_id),
        KEY plan_promotion_snapshots_standing (standing_key),
        KEY pps_promo_snapshot_index (plan_snapshot_id),
        KEY pps_promo_promotion_index (promotion_id),
        KEY pps_promo_gym_index (gym_id),
        CONSTRAINT pps_promo_gym_fk FOREIGN KEY (gym_id) REFERENCES gyms (id) ON DELETE CASCADE,
        CONSTRAINT pps_promo_snapshot_fk FOREIGN KEY (plan_snapshot_id) REFERENCES plan_snapshots (id) ON DELETE CASCADE,
        CONSTRAINT pps_promo_promotion_fk FOREIGN KEY (promotion_id) REFERENCES promotions (id) ON DELETE RESTRICT,
        CONSTRAINT chk_pps_promo_status CHECK (status IN ('applied','consumed','revoked','superseded'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  }
  for (const [name, abbr] of [
    ['plan_promotion_session_product_snapshots', 'ppsp'],
    ['plan_promotion_oneoff_product_snapshots', 'ppop'],
    ['plan_promotion_periodical_product_snapshots', 'pppp'],
  ]) {
    if (!(await knex.schema.hasTable(name))) await knex.raw(promotionProductTable(name, abbr));
  }
}

/**
 * Copies the Membership Plan side of the legacy model into the new tables. Repeatable: every
 * insert is guarded by the `source_*` key, so a retry adds nothing and an existing copy is
 * never rewritten. Nothing is fabricated: a value the source does not hold stays NULL.
 * Returns the number of rows inserted per table.
 */
async function backfillPlanSnapshots(knex) {
  const run = async (sql) => {
    const [res] = await knex.raw(sql);
    return Number(res.affectedRows || 0);
  };
  const counts = {};

  // One snapshot per Product Set version that carries a Membership Plan. The lifecycle of a
  // live Product Set follows its projected assignment (cancelled, expired, paused); a draft,
  // pending or superseded set keeps its own status.
  counts.plan_snapshots = await run(`
    INSERT INTO plan_snapshots
      (gym_id, product_set_id, member_id, membership_plan_id, status, is_inherited, starts_at, ends_at, closed_at,
       schedule_id, plan_price_id, base_price, discount_reason, discount_expires_at, membership_fee_price,
       free_periods, paid_periods, bonus_periods, pay_beforehand_periods, personal_fee_benefit_action,
       personal_fee_benefit_value, auto_renew, recurring_billing_interval, recurring_billing_unit, origin,
       source_plan_snapshot_id, source_user_membership_id, created_at, created_by)
    SELECT ps.gym_id, ps.id, ps.owner_member_id, ps.membership_plan_id,
           CASE WHEN ps.status = 'active' AND um.status IN ('paused','cancelled','expired') THEN um.status
                ELSE ps.status END,
           psps.is_inherited, ps.starts_at, ps.ends_at, um.closed_at,
           psps.schedule_id, psps.plan_price_id, psps.base_price, psps.discount_reason, psps.discount_expires_at,
           psps.membership_fee_price, psps.free_periods, psps.paid_periods, psps.bonus_periods,
           psps.pay_beforehand_periods, psps.personal_fee_benefit_action, psps.personal_fee_benefit_value,
           psps.auto_renew, psps.recurring_billing_interval, psps.recurring_billing_unit, psps.origin,
           psps.id, ps.user_membership_id, ps.created_at, ps.created_by
      FROM product_set_plan_snapshots psps
      JOIN product_sets ps ON ps.id = psps.product_set_id AND ps.gym_id = psps.gym_id
      LEFT JOIN user_memberships um ON um.id = ps.user_membership_id AND um.gym_id = ps.gym_id
     WHERE ps.membership_plan_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM plan_snapshots x WHERE x.source_plan_snapshot_id = psps.id)`);

  // Beneficiaries: the owner always, plus whoever the chain covers (read, never written, here).
  counts.plan_snapshot_beneficiaries = await run(`
    INSERT INTO plan_snapshot_beneficiaries (gym_id, plan_snapshot_id, member_id, is_owner)
    SELECT s.gym_id, s.id, s.member_id, 1 FROM plan_snapshots s
     WHERE NOT EXISTS (SELECT 1 FROM plan_snapshot_beneficiaries b
                        WHERE b.plan_snapshot_id = s.id AND b.member_id = s.member_id)`);
  counts.plan_snapshot_beneficiaries += await run(`
    INSERT INTO plan_snapshot_beneficiaries (gym_id, plan_snapshot_id, member_id, is_owner)
    SELECT s.gym_id, s.id, psm.member_id, 0
      FROM plan_snapshots s
      JOIN product_sets ps ON ps.id = s.product_set_id
      JOIN product_set_members psm ON psm.root_product_set_id = ps.root_product_set_id AND psm.gym_id = s.gym_id
     WHERE psm.member_id <> s.member_id
       AND NOT EXISTS (SELECT 1 FROM plan_snapshot_beneficiaries b
                        WHERE b.plan_snapshot_id = s.id AND b.member_id = psm.member_id)`);

  const included = [
    ['plan_session_snapshots', 'user_membership_session', 'frequency'],
    ['plan_oneoff_snapshots', 'user_membership_oneoff', null],
    ['plan_periodical_snapshots', 'user_membership_periodical', 'schedule_id'],
  ];
  for (const [target, source, extra] of included) {
    const extraCol = extra ? `, ${extra}` : '';
    const extraSel = extra ? `, u.${extra}` : '';
    counts[target] = await run(`
      INSERT INTO ${target}
        (gym_id, plan_snapshot_id, source_id, product_id, quantity, item_name, item_type, unit_price,
         item_billing_frequency, currency, action, value, mandatory${extraCol}, created_at)
      SELECT u.gym_id, s.id, u.id, u.product_id, u.quantity, u.item_name, u.item_type, u.unit_price,
             u.item_billing_frequency, u.currency, u.action, u.value, u.mandatory${extraSel}, u.created_at
        FROM ${source} u
        JOIN plan_snapshots s ON s.product_set_id = u.product_set_id AND s.gym_id = u.gym_id
       WHERE NOT EXISTS (SELECT 1 FROM ${target} x WHERE x.source_id = u.id)`);
  }

  // Membership Plan Promotion applications only. A plan application belongs to its assignment
  // (#1995) or, on a not-yet-projected Draft, to its version; the snapshot it lands on is the
  // version's own, else the assignment's latest version carrying a plan.
  counts.plan_promotion_snapshots = await run(`
    INSERT INTO plan_promotion_snapshots
      (gym_id, plan_snapshot_id, source_id, promotion_id, status, is_inherited, snapshot, applied_at, applied_by,
       consumed_at, revoked_at, created_at, created_by, modified_at, modified_by)
    SELECT ump.gym_id,
           COALESCE(
             (SELECT s.id FROM plan_snapshots s WHERE s.product_set_id = ump.product_set_id),
             (SELECT s2.id FROM plan_snapshots s2 JOIN product_sets p2 ON p2.id = s2.product_set_id
               WHERE ump.user_membership_id IS NOT NULL AND p2.user_membership_id = ump.user_membership_id
               ORDER BY p2.version DESC, p2.id DESC LIMIT 1)),
           ump.id, ump.promotion_id, ump.status, 0, ump.snapshot, ump.applied_at, ump.applied_by,
           ump.consumed_at, ump.revoked_at, ump.applied_at, ump.created_by, ump.modified_at, ump.modified_by
      FROM user_membership_promotions ump
      JOIN promotions pr ON pr.id = ump.promotion_id AND pr.applies_to = 'membership_plan'
     WHERE ump.recurrent_snapshot_id IS NULL
       AND COALESCE(
             (SELECT s.id FROM plan_snapshots s WHERE s.product_set_id = ump.product_set_id),
             (SELECT s2.id FROM plan_snapshots s2 JOIN product_sets p2 ON p2.id = s2.product_set_id
               WHERE ump.user_membership_id IS NOT NULL AND p2.user_membership_id = ump.user_membership_id
               ORDER BY p2.version DESC, p2.id DESC LIMIT 1)) IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM plan_promotion_snapshots x WHERE x.source_id = ump.id)`);

  for (const [target, source] of [
    ['plan_promotion_session_product_snapshots', 'user_membership_promotion_session_snapshot'],
    ['plan_promotion_oneoff_product_snapshots', 'user_membership_promotion_oneoff_snapshot'],
    ['plan_promotion_periodical_product_snapshots', 'user_membership_promotion_periodical_snapshot'],
  ]) {
    counts[target] = await run(`
      INSERT INTO ${target}
        (gym_id, plan_promotion_snapshot_id, source_id, product_id, product_name, quantity, item_type,
         item_billing_frequency, unit_price, currency, action, value, requirement, created_at)
      SELECT g.gym_id, pp.id, g.id, g.product_id, g.product_name, g.quantity, g.item_type,
             g.item_billing_frequency, g.unit_price, g.currency, g.action, g.value, g.requirement, g.created_at
        FROM ${source} g
        JOIN plan_promotion_snapshots pp ON pp.source_id = g.user_membership_promotion_id AND pp.gym_id = g.gym_id
       WHERE NOT EXISTS (SELECT 1 FROM ${target} x WHERE x.source_id = g.id)`);
  }
  return counts;
}

exports.backfillPlanSnapshots = backfillPlanSnapshots;

exports.up = async (knex) => {
  await createTables(knex);
  const counts = await backfillPlanSnapshots(knex);
  console.log(`migration 347: plan snapshots backfilled ${JSON.stringify(counts)}`);
};

exports.down = async (knex) => {
  for (const table of NEW_TABLES) await knex.schema.dropTableIfExists(table);
};
