/**
 * #949 stage 3 — the schema says **Product**.
 *
 * Stage 1 moved the copy a gym owner reads and stage 2 the identifiers a
 * TypeScript reader chooses. Both deliberately stopped at the wire and the
 * schema, because those are the two things a rename cannot do with an editor:
 * the owner's `Q1 C` answer on the thread ("a complete refactor to leave just
 * products", with `Q3` scoped to `gym_charges.type`) is what this migration
 * carries, together with the `/sellable-items` → `/products` API root in the
 * same PR.
 *
 * What moves here, and nothing else:
 *
 *   1. `gym_charges` → `products`, and `sellable_item_professional_services`
 *      → `product_professional_services` (migration 153).
 *   2. `gym_charge_id` → `product_id` on the thirteen tables that key to it —
 *      the six Membership Plan / Promotion benefit tables, the six
 *      assignment-side snapshot tables, and `user_membership_services` — plus
 *      `sellable_item_id` on the professional-services join table and the three
 *      promotion snapshots' `gym_charge_name` → `product_name`.
 *   3. `charge_types.is_gym_charge` → `is_product`. The **Charge Type** keeps
 *      its name (it is a different concept that merely shares a word, per the
 *      hard constraint), but this column says which Charge Types seed a
 *      per-gym Product, so it is named after the Product and not after the
 *      lookup row.
 *   4. The eight CHECKs on the table, and every index and FK constraint whose
 *      *name* spells the retired entity. MySQL updates an FK's column list
 *      when the column is renamed and leaves the constraint's own name alone,
 *      so the names are moved explicitly or the schema would read
 *      `products_… FOREIGN KEY (product_id)` under a `gym_charge` name for ever.
 *   5. Three stored values: `promotions.applies_to` `'sellable_item'` →
 *      `'product'` (with its CHECK rebuilt around the new set), the
 *      `financials.gym_charges` feature-flag key → `financials.products`, and
 *      `audit_logs.entity_type` `'gym_charge'` → `'product'`.
 *
 * ### The audit backfill, which is the one judgement call
 *
 * `audit_logs` is an append-only history, and stage 2's note said rewriting it
 * is rewriting what the system says happened. The owner answered `Q1 C` rather
 * than `Q1 D` (the tier that keeps `gym_charge` in the history behind a legacy
 * alias), so the rows move: `entity_type` is not a fact about the past but the
 * key the Audit Log's entity-type filter and `AUDIT_ENTITY_REGISTRY` are built
 * from, and a registry that no longer has a `gym_charge` entry would leave
 * every historical row of that type unnamed in the filter and without an
 * `entity_name`. The audited *values* (`previous_values` / `new_values`) are
 * left exactly as they were written — those are the record of what changed.
 *
 * ### Why this is one migration and not five
 *
 * Every statement below is a rename of the same entity. Splitting them would
 * leave a deployable commit where the API's SQL names a table that does not
 * exist yet, and there is no API-first/DB-first ordering that makes a rename
 * safe for a *running* build either way: `deploy.yml` runs `knex
 * migrate:latest` before the API container restarts, in the same job, so the
 * window where the old build meets the new schema is the few seconds of that
 * restart. That is the same trade migrations 197/199 took for a column drop,
 * and `docs/go-to-production.md` carries it as a release note.
 *
 * Every step is guarded by what it is about to change (`hasTable`,
 * `hasColumn`, a catalogue lookup for an index or a constraint), so a crash
 * half way through resumes cleanly on a re-run rather than failing on the first
 * already-applied statement. `down()` is the mirror, in reverse order, under
 * the same guards — this migration is reversible, which is what a rename with
 * no data loss ought to be.
 */

/**
 * Every name below is written as an `[old, new]` pair, and `applyRenames()`
 * walks them in one direction or the other — which is what makes `down()` the
 * same code rather than a second transcription of eighty names. A table that is
 * not itself renamed is written as a bare string.
 */
const pair = (x) => (Array.isArray(x) ? x : [x, x]);

/** The two tables, old → new. */
const TABLES = [
  ['gym_charges', 'products'],
  ['sellable_item_professional_services', 'product_professional_services'],
];

const PRODUCTS = TABLES[0];
const PPS = TABLES[1];
const ID = ['gym_charge_id', 'product_id'];
const NAME = ['gym_charge_name', 'product_name'];

/** `[table, [columnOld, columnNew]]`. */
const COLUMNS = [
  ['membership_plan_session', ID],
  ['membership_plan_oneoff', ID],
  ['membership_plan_periodical', ID],
  ['promotion_session', ID],
  ['promotion_oneoff', ID],
  ['promotion_periodical', ID],
  ['user_membership_session', ID],
  ['user_membership_oneoff', ID],
  ['user_membership_periodical', ID],
  ['user_membership_promotion_session_snapshot', ID],
  ['user_membership_promotion_session_snapshot', NAME],
  ['user_membership_promotion_oneoff_snapshot', ID],
  ['user_membership_promotion_oneoff_snapshot', NAME],
  ['user_membership_promotion_periodical_snapshot', ID],
  ['user_membership_promotion_periodical_snapshot', NAME],
  [PPS, ['sellable_item_id', 'product_id']],
  ['charge_types', ['is_gym_charge', 'is_product']],
];

/**
 * `user_membership_services.gym_charge_id` is renamed on its own, below: the
 * table's `open_service_key` VIRTUAL generated column (migration 164 — the
 * `ums_one_open_per_item` UNIQUE index's device) reads it, and MySQL refuses to
 * rename a column a generated column depends on
 * (ER_DEPENDENT_BY_GENERATED_COLUMN).
 */
const UMS = 'user_membership_services';
const UMS_KEY = 'open_service_key';
const UMS_UNIQUE = 'ums_one_open_per_item';
const umsKeyExpr = (column) =>
  `VARCHAR(32) GENERATED ALWAYS AS (IF(ends_at IS NULL, CONCAT(user_membership_id, ':', ${column}), NULL)) VIRTUAL`;

/** `[table, [indexOld, indexNew]]`. */
const INDEXES = [
  [PRODUCTS, ['gym_charges_gym_charge_type_unique', 'products_gym_id_charge_type_unique']],
  [PRODUCTS, ['gym_charges_charge_type_id_foreign', 'products_charge_type_id_foreign']],
  [PRODUCTS, ['gym_charges_class_package_id_foreign', 'products_class_package_id_foreign']],
  [PRODUCTS, ['gym_charges_created_by_membership_id_foreign', 'products_created_by_membership_id_foreign']],
  [PRODUCTS, ['gym_charges_deleted_by_membership_id_foreign', 'products_deleted_by_membership_id_foreign']],
  [PRODUCTS, ['gym_charges_modified_by_membership_id_foreign', 'products_modified_by_membership_id_foreign']],
  [PRODUCTS, ['gym_charges_tax_rate_id_foreign', 'products_tax_rate_id_foreign']],
  ['membership_plan_session', ['membership_plan_session_gym_charge_id_foreign', 'membership_plan_session_product_id_foreign']],
  ['membership_plan_session', ['membership_plan_session_plan_charge_unique', 'membership_plan_session_plan_product_unique']],
  ['membership_plan_oneoff', ['membership_plan_oneoff_gym_charge_id_foreign', 'membership_plan_oneoff_product_id_foreign']],
  ['membership_plan_oneoff', ['membership_plan_oneoff_plan_charge_unique', 'membership_plan_oneoff_plan_product_unique']],
  ['membership_plan_periodical', ['membership_plan_periodical_gym_charge_id_foreign', 'membership_plan_periodical_product_id_foreign']],
  ['membership_plan_periodical', ['membership_plan_periodical_plan_charge_unique', 'membership_plan_periodical_plan_product_unique']],
  ['promotion_session', ['promotion_session_gym_charge_id_foreign', 'promotion_session_product_id_foreign']],
  ['promotion_session', ['promotion_session_promotion_charge_unique', 'promotion_session_promotion_product_unique']],
  ['promotion_oneoff', ['promotion_oneoff_gym_charge_id_foreign', 'promotion_oneoff_product_id_foreign']],
  ['promotion_oneoff', ['promotion_oneoff_promotion_charge_unique', 'promotion_oneoff_promotion_product_unique']],
  ['promotion_periodical', ['promotion_periodical_gym_charge_id_foreign', 'promotion_periodical_product_id_foreign']],
  ['promotion_periodical', ['promotion_periodical_promotion_charge_unique', 'promotion_periodical_promotion_product_unique']],
  ['user_membership_session', ['user_membership_session_gym_charge_id_foreign', 'user_membership_session_product_id_foreign']],
  ['user_membership_session', ['user_membership_session_membership_charge_unique', 'user_membership_session_membership_product_unique']],
  ['user_membership_oneoff', ['user_membership_oneoff_gym_charge_id_foreign', 'user_membership_oneoff_product_id_foreign']],
  ['user_membership_oneoff', ['user_membership_oneoff_membership_charge_unique', 'user_membership_oneoff_membership_product_unique']],
  ['user_membership_periodical', ['user_membership_periodical_gym_charge_id_foreign', 'user_membership_periodical_product_id_foreign']],
  ['user_membership_periodical', ['user_membership_periodical_membership_charge_unique', 'user_membership_periodical_membership_product_unique']],
  ['user_membership_promotion_session_snapshot', ['ump_session_snap_gym_charge_id_fk', 'ump_session_snap_product_id_fk']],
  ['user_membership_promotion_oneoff_snapshot', ['ump_oneoff_snap_gym_charge_id_fk', 'ump_oneoff_snap_product_id_fk']],
  ['user_membership_promotion_periodical_snapshot', ['ump_periodical_snap_gym_charge_id_fk', 'ump_periodical_snap_product_id_fk']],
  [PPS, ['sips_item_service_unique', 'pps_product_service_unique']],
  [UMS, ['user_membership_services_gym_charge_id_foreign', 'user_membership_services_product_id_foreign']],
];

/**
 * `[table, [nameOld, nameNew], [columnOld, columnNew], [targetOld, targetNew], onDelete]`
 * — the FK constraints whose names spell the retired entity. MySQL has no
 * `RENAME CONSTRAINT`, so each is dropped and re-added with the same column,
 * target and referential action; the backing index is already renamed above,
 * and `ADD CONSTRAINT … FOREIGN KEY` reuses it rather than creating a second.
 *
 * `onDelete` is `null` for the four tables that reference the catalogue with
 * **no** action — an assignment's frozen line must not disappear because a
 * Product was hard-deleted (migration 164) — and MySQL's implicit `RESTRICT`
 * is what says so.
 */
const FOREIGN_KEYS = [
  [PRODUCTS, ['gym_charges_charge_type_id_foreign', 'products_charge_type_id_foreign'], 'charge_type_id', 'charge_types', 'CASCADE'],
  [PRODUCTS, ['gym_charges_class_package_id_foreign', 'products_class_package_id_foreign'], 'class_package_id', 'class_packages', 'SET NULL'],
  [PRODUCTS, ['gym_charges_created_by_membership_id_foreign', 'products_created_by_membership_id_foreign'], 'created_by_membership_id', 'gym_memberships', 'SET NULL'],
  [PRODUCTS, ['gym_charges_deleted_by_membership_id_foreign', 'products_deleted_by_membership_id_foreign'], 'deleted_by_membership_id', 'gym_memberships', 'SET NULL'],
  [PRODUCTS, ['gym_charges_modified_by_membership_id_foreign', 'products_modified_by_membership_id_foreign'], 'modified_by_membership_id', 'gym_memberships', 'SET NULL'],
  [PRODUCTS, ['gym_charges_gym_id_foreign', 'products_gym_id_foreign'], 'gym_id', 'gyms', 'CASCADE'],
  [PRODUCTS, ['gym_charges_tax_rate_id_foreign', 'products_tax_rate_id_foreign'], 'tax_rate_id', 'tax_rates', 'SET NULL'],
  ['membership_plan_session', ['membership_plan_session_gym_charge_id_foreign', 'membership_plan_session_product_id_foreign'], ID, PRODUCTS, 'CASCADE'],
  ['membership_plan_oneoff', ['membership_plan_oneoff_gym_charge_id_foreign', 'membership_plan_oneoff_product_id_foreign'], ID, PRODUCTS, 'CASCADE'],
  ['membership_plan_periodical', ['membership_plan_periodical_gym_charge_id_foreign', 'membership_plan_periodical_product_id_foreign'], ID, PRODUCTS, 'CASCADE'],
  ['promotion_session', ['promotion_session_gym_charge_id_foreign', 'promotion_session_product_id_foreign'], ID, PRODUCTS, 'CASCADE'],
  ['promotion_oneoff', ['promotion_oneoff_gym_charge_id_foreign', 'promotion_oneoff_product_id_foreign'], ID, PRODUCTS, 'CASCADE'],
  ['promotion_periodical', ['promotion_periodical_gym_charge_id_foreign', 'promotion_periodical_product_id_foreign'], ID, PRODUCTS, 'CASCADE'],
  ['user_membership_session', ['user_membership_session_gym_charge_id_foreign', 'user_membership_session_product_id_foreign'], ID, PRODUCTS, null],
  ['user_membership_oneoff', ['user_membership_oneoff_gym_charge_id_foreign', 'user_membership_oneoff_product_id_foreign'], ID, PRODUCTS, null],
  ['user_membership_periodical', ['user_membership_periodical_gym_charge_id_foreign', 'user_membership_periodical_product_id_foreign'], ID, PRODUCTS, null],
  ['user_membership_promotion_session_snapshot', ['ump_session_snap_gym_charge_id_fk', 'ump_session_snap_product_id_fk'], ID, PRODUCTS, 'SET NULL'],
  ['user_membership_promotion_oneoff_snapshot', ['ump_oneoff_snap_gym_charge_id_fk', 'ump_oneoff_snap_product_id_fk'], ID, PRODUCTS, 'SET NULL'],
  ['user_membership_promotion_periodical_snapshot', ['ump_periodical_snap_gym_charge_id_fk', 'ump_periodical_snap_product_id_fk'], ID, PRODUCTS, 'SET NULL'],
  [UMS, ['user_membership_services_gym_charge_id_foreign', 'user_membership_services_product_id_foreign'], ID, PRODUCTS, null],
  [PPS, ['sellable_item_professional_services_gym_id_foreign', 'product_professional_services_gym_id_foreign'], 'gym_id', 'gyms', 'CASCADE'],
  [PPS, ['sellable_item_professional_services_sellable_item_id_foreign', 'product_professional_services_product_id_foreign'], ['sellable_item_id', 'product_id'], PRODUCTS, 'CASCADE'],
];

/**
 * The table's eight CHECKs, old name → new name with the clause re-declared
 * exactly as migrations 102/112/122/123/135 left it. MySQL cannot rename a
 * CHECK either, so each is dropped and re-added — all in **one** `ALTER`, since
 * `ADD CONSTRAINT … CHECK` is `ALGORITHM=COPY` (MySQL refuses INPLACE) and one
 * statement is one rebuild rather than eight.
 *
 * Nothing here widens or narrows a set: `billing_frequency` still admits the
 * two retired values #821 and #945 left stored (`week`, `per_session`), which
 * is the whole reason that CHECK is not where the offered list lives.
 */
const CHECKS = [
  [['gym_charges_type_check', 'products_type_check'], "`type` IN ('fee','service','sessions','merchandise','other')"],
  [['gym_charges_billing_frequency_check', 'products_billing_frequency_check'], "`billing_frequency` IS NULL OR `billing_frequency` IN ('once','per_session','four_weeks','week','month','year')"],
  [['gym_charges_status_check', 'products_status_check'], "`status` IN ('active','inactive')"],
  [['gym_charges_units_check', 'products_units_check'], '`units` IS NULL OR `units` > 0'],
  [['gym_charges_currency_check', 'products_currency_check'], "`currency` = 'EUR'"],
  [['gym_charges_availability_check', 'products_availability_check'], "`availability` IN ('available','unavailable')"],
  [['gym_charges_tax_behavior_check', 'products_tax_behavior_check'], "`tax_behavior` IN ('inclusive','exclusive')"],
  [['chk_gym_charges_enrollment_status', 'chk_products_enrollment_status'], "`enrollment_status` IN ('public','staff_only')"],
];

/**
 * `promotions.applies_to` (#926, migration 204). The stored value moves with
 * the entity's name, so the CHECK is rebuilt around the new set — and the set
 * is exported for the reason migration 204 exported its own:
 * `promotion-target.unit.test.ts` asserts the database admits exactly what
 * `api/src/domain/promotionTarget.ts` accepts, and without that a third target
 * would surface as a 500 on save.
 */
const TARGET_CHECK = 'chk_promotions_applies_to';
/** Mirrors PROMOTION_TARGETS in api/src/domain/promotionTarget.ts. */
const TARGETS = ['membership_plan', 'product'];
const RETIRED_TARGET = 'sellable_item';

const FEATURE_KEY = ['financials.gym_charges', 'financials.products'];
const AUDIT_ENTITY = ['gym_charge', 'product'];

exports.TABLES = TABLES;
exports.COLUMNS = COLUMNS;
exports.CHECKS = CHECKS;
exports.TARGETS = TARGETS;
exports.TARGET_CHECK = TARGET_CHECK;
exports.FEATURE_KEY = FEATURE_KEY;
exports.AUDIT_ENTITY = AUDIT_ENTITY;

/** Does this table carry an index of this name? */
const hasIndex = async (knex, table, index) => {
  const [[row]] = await knex.raw(
    `SELECT COUNT(*) AS cnt FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
    [table, index],
  );
  return Number(row.cnt) > 0;
};

/** Does this table carry a constraint (FK or CHECK) of this name? */
const hasConstraint = async (knex, table, name) => {
  const [[row]] = await knex.raw(
    `SELECT COUNT(*) AS cnt FROM information_schema.TABLE_CONSTRAINTS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ?`,
    [table, name],
  );
  return Number(row.cnt) > 0;
};

/**
 * Renames the tables, columns, indexes, FKs and CHECKs. Every list above reads
 * old → new; `reverse` walks them the other way, which is `down()`.
 *
 * The order matters and is the same in both directions: the tables go first, so
 * every statement after them names the table as it is *now* — which is also why
 * each entry carries its table as a pair.
 */
async function applyRenames(knex, reverse) {
  const side = (x) => pair(x)[reverse ? 0 : 1];
  const from = (x) => pair(x)[reverse ? 1 : 0];

  for (const t of TABLES) {
    if (await knex.schema.hasTable(from(t))) {
      await knex.raw(`RENAME TABLE \`${from(t)}\` TO \`${side(t)}\``);
    }
  }

  // The foreign keys come off **before** the columns are renamed, and go back
  // on afterwards under their new names. MySQL will not rename a column that
  // participates in a foreign key on `user_membership_services`: it answers
  // "ALGORITHM=COPY is not supported … Columns participating in a foreign key
  // are renamed. Try ALGORITHM=INPLACE" and then refuses INPLACE as well, so
  // there is no algorithm that does it with the constraint in place. Dropping
  // the constraint first works everywhere and is what also moves the
  // constraint's own name, which MySQL has no `RENAME CONSTRAINT` for.
  for (const [table, name] of FOREIGN_KEYS) {
    const t = side(table);
    if (await hasConstraint(knex, t, from(name))) {
      await knex.raw(`ALTER TABLE \`${t}\` DROP FOREIGN KEY \`${from(name)}\``);
    }
  }

  // `user_membership_services.open_service_key` is a VIRTUAL generated column
  // reading the column about to be renamed (migration 164 — the
  // `ums_one_open_per_item` UNIQUE index's device), and MySQL refuses to rename
  // a column a generated column depends on (ER_DEPENDENT_BY_GENERATED_COLUMN).
  // So it comes off here and goes back below reading the new name. The index is
  // dropped explicitly first: dropping the column alone takes it with it
  // implicitly, and a resumed run could then find neither.
  if (await knex.schema.hasColumn(UMS, from(ID))) {
    if (await hasIndex(knex, UMS, UMS_UNIQUE)) {
      await knex.raw(`ALTER TABLE \`${UMS}\` DROP INDEX \`${UMS_UNIQUE}\``);
    }
    if (await knex.schema.hasColumn(UMS, UMS_KEY)) {
      await knex.raw(`ALTER TABLE \`${UMS}\` DROP COLUMN \`${UMS_KEY}\``);
    }
  }

  for (const [table, column] of [...COLUMNS, [UMS, ID]]) {
    const t = side(table);
    if (await knex.schema.hasColumn(t, from(column))) {
      await knex.raw(`ALTER TABLE \`${t}\` RENAME COLUMN \`${from(column)}\` TO \`${side(column)}\``);
    }
  }

  if (!(await knex.schema.hasColumn(UMS, UMS_KEY))) {
    // Restored in its original position (migration 164 put it after
    // `created_by_membership_id`), so a `SHOW CREATE TABLE` diff across this
    // migration reads as a rename and nothing else.
    await knex.raw(
      `ALTER TABLE \`${UMS}\` ADD COLUMN \`${UMS_KEY}\` ${umsKeyExpr(side(ID))} AFTER \`created_by_membership_id\``,
    );
  }
  if (!(await hasIndex(knex, UMS, UMS_UNIQUE))) {
    await knex.raw(`ALTER TABLE \`${UMS}\` ADD UNIQUE INDEX \`${UMS_UNIQUE}\` (\`${UMS_KEY}\`)`);
  }

  // Guarded one by one, because InnoDB drops the index it created for a foreign
  // key along with the constraint: where that happened there is nothing left to
  // rename and the `ADD CONSTRAINT` below creates it under the new name
  // instead, and where the index was declared separately it is renamed here.
  for (const [table, index] of INDEXES) {
    const t = side(table);
    if (await hasIndex(knex, t, from(index))) {
      await knex.raw(`ALTER TABLE \`${t}\` RENAME INDEX \`${from(index)}\` TO \`${side(index)}\``);
    }
  }

  for (const [table, name, column, ref, onDelete] of FOREIGN_KEYS) {
    const t = side(table);
    if (await hasConstraint(knex, t, side(name))) continue;
    await knex.raw(
      `ALTER TABLE \`${t}\` ADD CONSTRAINT \`${side(name)}\` ` +
      `FOREIGN KEY (\`${side(column)}\`) REFERENCES \`${side(ref)}\` (\`id\`)` +
      `${onDelete ? ` ON DELETE ${onDelete}` : ''}`,
    );
  }

  const checksTable = side(PRODUCTS);
  const drops = [];
  const adds = [];
  for (const [name, clause] of CHECKS) {
    if (!(await hasConstraint(knex, checksTable, from(name)))) continue;
    drops.push(`DROP CHECK \`${from(name)}\``);
    adds.push(`ADD CONSTRAINT \`${side(name)}\` CHECK (${clause})`);
  }
  if (drops.length > 0) {
    await knex.raw(`ALTER TABLE \`${checksTable}\` ${[...drops, ...adds].join(', ')}`);
  }
}

/** The `applies_to` CHECK's clause with MySQL's escaping removed, or null. */
const targetCheckClause = async (knex) => {
  const [[existing]] = await knex.raw(
    `SELECT cc.CHECK_CLAUSE AS clause
       FROM information_schema.CHECK_CONSTRAINTS cc
       JOIN information_schema.TABLE_CONSTRAINTS tc
         ON tc.CONSTRAINT_SCHEMA = cc.CONSTRAINT_SCHEMA
        AND tc.CONSTRAINT_NAME = cc.CONSTRAINT_NAME
      WHERE tc.TABLE_SCHEMA = DATABASE()
        AND tc.TABLE_NAME = 'promotions'
        AND cc.CONSTRAINT_NAME = ?`,
    [TARGET_CHECK],
  );
  return existing?.clause == null ? null : String(existing.clause).replace(/\\/g, '');
};

/**
 * Moves the stored `promotions.applies_to` value. The CHECK has to come off
 * before the UPDATE — the new value is not in the old set, so the UPDATE would
 * be refused — and goes back around the new one, which is also what makes this
 * resumable: the clause itself says which side of the rename the table is on.
 */
async function moveTarget(knex, from, to, accepted) {
  const clause = await targetCheckClause(knex);
  if (clause != null && accepted.every((v) => clause.includes(`'${v}'`))) return;
  if (clause != null) await knex.raw(`ALTER TABLE promotions DROP CHECK ${TARGET_CHECK}`);
  await knex('promotions').where({ applies_to: from }).update({ applies_to: to });
  await knex.raw(
    `ALTER TABLE promotions ADD CONSTRAINT ${TARGET_CHECK} ` +
    `CHECK (applies_to IN (${accepted.map((v) => `'${v}'`).join(',')}))`,
  );
}

exports.up = async (knex) => {
  await applyRenames(knex, false);
  await moveTarget(knex, RETIRED_TARGET, 'product', TARGETS);

  // The feature flag is one row per key (`feature_flags_feature_key_unique`),
  // so this is an UPDATE and not an insert-and-delete: the gym's own
  // enabled/disabled choice, and who last changed it, travel with the key.
  await knex('feature_flags').where({ feature_key: FEATURE_KEY[0] }).update({ feature_key: FEATURE_KEY[1] });

  // The audit history's `entity_type`, per the header's note. `entity_name` and
  // both value payloads are untouched.
  await knex('audit_logs').where({ entity_type: AUDIT_ENTITY[0] }).update({ entity_type: AUDIT_ENTITY[1] });
};

exports.down = async (knex) => {
  await knex('audit_logs').where({ entity_type: AUDIT_ENTITY[1] }).update({ entity_type: AUDIT_ENTITY[0] });
  await knex('feature_flags').where({ feature_key: FEATURE_KEY[1] }).update({ feature_key: FEATURE_KEY[0] });
  await moveTarget(knex, 'product', RETIRED_TARGET, ['membership_plan', RETIRED_TARGET]);
  await applyRenames(knex, true);
};
