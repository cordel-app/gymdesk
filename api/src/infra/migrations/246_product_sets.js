/**
 * #1325 PR 1 — ProductSet: the versioned commercial configuration.
 *
 * Additive only. Nothing is read from these tables by the billing run yet and
 * nothing is dropped: every legacy column and FK stays until the readers and
 * writers have moved (the development reset and the NOT NULL / DROP steps are
 * PR 3). Every new FK column on an existing table is NULLable for that reason.
 *
 *   product_sets                 one row per version of a member's commercial
 *                                configuration; `root_product_set_id` is the
 *                                chain (= its own id on v1).
 *   product_set_plan_snapshots   the frozen Membership Plan scalars of one
 *                                version (0..1 per set: a locker-only set has
 *                                none). Moved off `user_memberships` in PR 3.
 *   product_set_schedules        a recurring billing schedule, with a stable
 *                                identity across the versions of one chain.
 *   product_set_members          family coverage, keyed by the chain root so a
 *                                covered member follows whichever version is
 *                                active and no ProductSet is copied for them.
 *
 * The database guarantees at most one `active` and at most one in-flight
 * (`draft` or `pending_payment`) version per owner through two UNIQUE
 * generated columns — the migration 213 device — and the application
 * guarantees the rest. A Draft is persisted as the user edits it section by
 * section and expires after two hours without activity (`last_activity_at`,
 * refreshed by every successful Draft update); an expired Draft is deleted
 * lazily when its owner starts a new one and by the scheduled cleanup, and is
 * never a Pending Payment or later set.
 *
 * Deletion policy (#1325 decision 7): CASCADE from the gym and from the owning
 * set to its dependants; RESTRICT on the owner so a member hard-delete cannot
 * cascade into financial history; SET NULL on `previous_product_set_id` so
 * deleting an old version never cascades through a chain. The application never
 * deletes a ProductSet: only a Pending Payment set explicitly cancelled, and the
 * guarded development reset.
 *
 * Also adds the audit snapshot pairs `user_memberships` lacks (#1182's plain
 * text convention): `modified_*` and `deleted_*`. `deleted_at` is the
 * administrative removal of an assignment, distinct from `cancelled`/`closed`.
 */

const SET_TABLE = 'product_sets';
const RE_KEYED = [
  'user_membership_session',
  'user_membership_oneoff',
  'user_membership_periodical',
  'user_membership_services',
  'user_membership_promotions',
];
// The two item tables a recurring schedule applies to (session allowances are
// summarised onto the events and never get a schedule, #918).
const SCHEDULED = ['user_membership_periodical', 'user_membership_services'];

exports.up = async (knex) => {
  if (!(await knex.schema.hasTable(SET_TABLE))) {
    await knex.raw(`
      CREATE TABLE ${SET_TABLE} (
        id                      INT UNSIGNED NOT NULL AUTO_INCREMENT,
        gym_id                  CHAR(36)     NOT NULL,
        owner_member_id         INT UNSIGNED NOT NULL,
        root_product_set_id     INT UNSIGNED NULL,
        previous_product_set_id INT UNSIGNED NULL,
        version                 INT UNSIGNED NOT NULL DEFAULT 1,
        status                  VARCHAR(20)  NOT NULL DEFAULT 'draft',
        membership_plan_id      INT UNSIGNED NULL,
        starts_at               DATE         NOT NULL,
        ends_at                 DATE         NULL,
        payment_request_id      INT UNSIGNED NULL,
        last_activity_at        DATETIME     NOT NULL DEFAULT (UTC_TIMESTAMP()),
        activated_at            DATETIME     NULL,
        superseded_at           DATETIME     NULL,
        created_at              DATETIME     NOT NULL DEFAULT (UTC_TIMESTAMP()),
        created_by_name         VARCHAR(255) NULL,
        created_by_type         VARCHAR(20)  NULL,
        active_owner_key        INT UNSIGNED GENERATED ALWAYS AS (
                                  IF(status = 'active', owner_member_id, NULL)
                                ) VIRTUAL,
        pending_owner_key       INT UNSIGNED GENERATED ALWAYS AS (
                                  IF(status IN ('draft','pending_payment'), owner_member_id, NULL)
                                ) VIRTUAL,
        PRIMARY KEY (id),
        UNIQUE KEY product_sets_one_active (active_owner_key),
        UNIQUE KEY product_sets_one_in_flight (pending_owner_key),
        UNIQUE KEY product_sets_chain_version (root_product_set_id, version),
        KEY product_sets_gym_owner_index (gym_id, owner_member_id, status),
        CONSTRAINT product_sets_gym_fk FOREIGN KEY (gym_id) REFERENCES gyms (id) ON DELETE CASCADE,
        CONSTRAINT product_sets_owner_fk FOREIGN KEY (owner_member_id) REFERENCES members (id) ON DELETE RESTRICT,
        CONSTRAINT product_sets_root_fk FOREIGN KEY (root_product_set_id) REFERENCES ${SET_TABLE} (id) ON DELETE CASCADE,
        CONSTRAINT product_sets_previous_fk FOREIGN KEY (previous_product_set_id) REFERENCES ${SET_TABLE} (id) ON DELETE SET NULL,
        CONSTRAINT product_sets_plan_fk FOREIGN KEY (membership_plan_id) REFERENCES membership_plans (id) ON DELETE RESTRICT,
        CONSTRAINT product_sets_payment_request_fk FOREIGN KEY (payment_request_id) REFERENCES payment_requests (id) ON DELETE SET NULL,
        CONSTRAINT chk_product_sets_status CHECK (status IN ('draft','pending_payment','active','superseded'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
  }

  if (!(await knex.schema.hasTable('product_set_schedules'))) {
    await knex.raw(`
      CREATE TABLE product_set_schedules (
        id                  INT UNSIGNED NOT NULL AUTO_INCREMENT,
        gym_id              CHAR(36)     NOT NULL,
        root_product_set_id INT UNSIGNED NOT NULL,
        schedule_key        VARCHAR(40)  NOT NULL,
        anchor_date         DATE         NOT NULL,
        cadence_interval    INT UNSIGNED NOT NULL,
        cadence_unit        VARCHAR(10)  NOT NULL,
        created_at          DATETIME     NOT NULL DEFAULT (UTC_TIMESTAMP()),
        PRIMARY KEY (id),
        UNIQUE KEY pss_chain_key (root_product_set_id, schedule_key),
        KEY pss_gym_index (gym_id),
        CONSTRAINT pss_gym_fk FOREIGN KEY (gym_id) REFERENCES gyms (id) ON DELETE CASCADE,
        CONSTRAINT pss_root_fk FOREIGN KEY (root_product_set_id) REFERENCES ${SET_TABLE} (id) ON DELETE CASCADE,
        CONSTRAINT chk_pss_interval CHECK (cadence_interval > 0),
        CONSTRAINT chk_pss_unit CHECK (cadence_unit IN ('day','week','month','year'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
  }

  if (!(await knex.schema.hasTable('product_set_plan_snapshots'))) {
    await knex.raw(`
      CREATE TABLE product_set_plan_snapshots (
        id                         INT UNSIGNED  NOT NULL AUTO_INCREMENT,
        gym_id                     CHAR(36)      NOT NULL,
        product_set_id             INT UNSIGNED  NOT NULL,
        schedule_id                INT UNSIGNED  NULL,
        plan_price_id              INT UNSIGNED  NULL,
        base_price                 DECIMAL(10,2) NULL,
        discount_reason            TEXT          NULL,
        discount_expires_at        DATE          NULL,
        membership_fee_price       DECIMAL(10,2) NULL,
        free_periods               INT UNSIGNED  NULL,
        paid_periods               INT UNSIGNED  NULL,
        bonus_periods              INT UNSIGNED  NULL,
        pay_beforehand_periods     INT UNSIGNED  NULL,
        personal_fee_benefit_action VARCHAR(30)  NOT NULL DEFAULT 'no_benefit',
        personal_fee_benefit_value DECIMAL(10,2) NULL,
        auto_renew                 TINYINT(1)    NOT NULL DEFAULT 0,
        created_at                 DATETIME      NOT NULL DEFAULT (UTC_TIMESTAMP()),
        PRIMARY KEY (id),
        UNIQUE KEY psps_product_set_key (product_set_id),
        KEY psps_gym_index (gym_id),
        CONSTRAINT psps_gym_fk FOREIGN KEY (gym_id) REFERENCES gyms (id) ON DELETE CASCADE,
        CONSTRAINT psps_set_fk FOREIGN KEY (product_set_id) REFERENCES ${SET_TABLE} (id) ON DELETE CASCADE,
        CONSTRAINT psps_schedule_fk FOREIGN KEY (schedule_id) REFERENCES product_set_schedules (id) ON DELETE SET NULL,
        CONSTRAINT psps_price_fk FOREIGN KEY (plan_price_id) REFERENCES membership_plan_prices (id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
  }

  if (!(await knex.schema.hasTable('product_set_members'))) {
    await knex.raw(`
      CREATE TABLE product_set_members (
        id                  INT UNSIGNED NOT NULL AUTO_INCREMENT,
        gym_id              CHAR(36)     NOT NULL,
        root_product_set_id INT UNSIGNED NOT NULL,
        member_id           INT UNSIGNED NOT NULL,
        is_owner            TINYINT(1)   NOT NULL DEFAULT 0,
        created_at          DATETIME     NOT NULL DEFAULT (UTC_TIMESTAMP()),
        PRIMARY KEY (id),
        UNIQUE KEY psm_chain_member_key (root_product_set_id, member_id),
        KEY psm_member_index (member_id),
        KEY psm_gym_index (gym_id),
        CONSTRAINT psm_gym_fk FOREIGN KEY (gym_id) REFERENCES gyms (id) ON DELETE CASCADE,
        CONSTRAINT psm_root_fk FOREIGN KEY (root_product_set_id) REFERENCES ${SET_TABLE} (id) ON DELETE CASCADE,
        CONSTRAINT psm_member_fk FOREIGN KEY (member_id) REFERENCES members (id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
  }

  // Re-keyed configuration: the version that owns the row. NULLable until the
  // readers and writers have moved and the legacy rows are gone (PR 3).
  for (const table of RE_KEYED) {
    if (!(await knex.schema.hasColumn(table, 'product_set_id'))) {
      await knex.raw(`ALTER TABLE ${table}
        ADD COLUMN product_set_id INT UNSIGNED NULL,
        ADD KEY ${table}_product_set_index (product_set_id),
        ADD CONSTRAINT ${table}_product_set_fk FOREIGN KEY (product_set_id) REFERENCES ${SET_TABLE} (id) ON DELETE CASCADE`);
    }
  }
  for (const table of SCHEDULED) {
    if (!(await knex.schema.hasColumn(table, 'schedule_id'))) {
      await knex.raw(`ALTER TABLE ${table}
        ADD COLUMN schedule_id INT UNSIGNED NULL,
        ADD KEY ${table}_schedule_index (schedule_id),
        ADD CONSTRAINT ${table}_schedule_fk FOREIGN KEY (schedule_id) REFERENCES product_set_schedules (id) ON DELETE SET NULL`);
    }
  }

  // #1182's plain-text actor snapshots, which `user_memberships` lacked.
  if (!(await knex.schema.hasColumn('user_memberships', 'modified_at'))) {
    await knex.raw(`ALTER TABLE user_memberships
      ADD COLUMN modified_at DATETIME NULL,
      ADD COLUMN modified_by_name VARCHAR(255) NULL,
      ADD COLUMN modified_by_type VARCHAR(20) NULL,
      ADD COLUMN deleted_at DATETIME NULL,
      ADD COLUMN deleted_by_name VARCHAR(255) NULL,
      ADD COLUMN deleted_by_type VARCHAR(20) NULL`);
  }
};

exports.down = async (knex) => {
  for (const table of ['user_membership_session', 'user_membership_oneoff', 'user_membership_periodical',
    'user_membership_services', 'user_membership_promotions']) {
    if (await knex.schema.hasColumn(table, 'product_set_id')) {
      await knex.raw(`ALTER TABLE ${table}
        DROP FOREIGN KEY ${table}_product_set_fk, DROP KEY ${table}_product_set_index, DROP COLUMN product_set_id`);
    }
  }
  for (const table of SCHEDULED) {
    if (await knex.schema.hasColumn(table, 'schedule_id')) {
      await knex.raw(`ALTER TABLE ${table}
        DROP FOREIGN KEY ${table}_schedule_fk, DROP KEY ${table}_schedule_index, DROP COLUMN schedule_id`);
    }
  }
  if (await knex.schema.hasColumn('user_memberships', 'modified_at')) {
    await knex.raw(`ALTER TABLE user_memberships
      DROP COLUMN modified_at, DROP COLUMN modified_by_name, DROP COLUMN modified_by_type,
      DROP COLUMN deleted_at, DROP COLUMN deleted_by_name, DROP COLUMN deleted_by_type`);
  }
  await knex.schema.dropTableIfExists('product_set_members');
  await knex.schema.dropTableIfExists('product_set_plan_snapshots');
  await knex.schema.dropTableIfExists('product_set_schedules');
  await knex.schema.dropTableIfExists(SET_TABLE);
};
