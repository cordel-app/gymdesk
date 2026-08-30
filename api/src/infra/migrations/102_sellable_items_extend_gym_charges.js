/**
 * #271: Extend gym_charges to become the Sellable Items catalogue.
 *
 * Adds: name, type, units, status, is_system, deleted_at/by, package_information, validity_days.
 * Makes charge_type_id nullable (custom items have no charge type).
 * Extends billing_frequency CHECK to include 'per_session'.
 * Backfills existing rows as system items.
 */
exports.up = async (knex) => {
  const has = (col) => knex.schema.hasColumn('gym_charges', col);

  const constraintExists = (name) =>
    knex.raw(
      `SELECT COUNT(*) AS cnt FROM information_schema.TABLE_CONSTRAINTS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'gym_charges' AND CONSTRAINT_NAME = ?`,
      [name],
    ).then(([rows]) => rows[0].cnt > 0);

  // BLOCKER FIX: Make charge_type_id nullable so custom items (no charge type) can be inserted.
  // The column already exists from migration 088; we only alter its nullability.
  const hasCtid = await has('charge_type_id');
  if (hasCtid) {
    // Alter to nullable — safe to re-run (.alter() is idempotent if already nullable)
    await knex.schema.alterTable('gym_charges', (t) => {
      t.integer('charge_type_id').unsigned().nullable()
        .references('id').inTable('charge_types').onDelete('CASCADE')
        .alter();
    });
  }

  // name — backfilled from charge_types.name for system rows
  if (!(await has('name'))) {
    await knex.schema.alterTable('gym_charges', (t) => {
      t.string('name', 255).nullable().after('gym_id');
    });
    await knex.raw(`
      UPDATE gym_charges gc
      JOIN charge_types ct ON ct.id = gc.charge_type_id
      SET gc.name = ct.name
    `);
  }

  // type — backfill system rows as 'fee'
  if (!(await has('type'))) {
    await knex.schema.alterTable('gym_charges', (t) => {
      t.string('type', 20).nullable().after('name');
    });
    await knex.raw(`UPDATE gym_charges SET type = 'fee'`);
  }
  if (!(await constraintExists('gym_charges_type_check'))) {
    await knex.raw(
      'ALTER TABLE gym_charges ADD CONSTRAINT gym_charges_type_check ' +
      "CHECK (type IN ('fee','service','sessions','merchandise','other'))",
    );
  }

  // units — nullable positive integer
  if (!(await has('units'))) {
    await knex.schema.alterTable('gym_charges', (t) => {
      t.integer('units').unsigned().nullable().after('type');
    });
  }
  if (!(await constraintExists('gym_charges_units_check'))) {
    await knex.raw(
      'ALTER TABLE gym_charges ADD CONSTRAINT gym_charges_units_check ' +
      'CHECK (units IS NULL OR units > 0)',
    );
  }

  // status — backfill from availability
  if (!(await has('status'))) {
    await knex.schema.alterTable('gym_charges', (t) => {
      t.string('status', 20).notNullable().defaultTo('active').after('units');
    });
    await knex.raw(`
      UPDATE gym_charges
      SET status = CASE WHEN availability = 'available' THEN 'active' ELSE 'inactive' END
    `);
  }
  if (!(await constraintExists('gym_charges_status_check'))) {
    await knex.raw(
      'ALTER TABLE gym_charges ADD CONSTRAINT gym_charges_status_check ' +
      "CHECK (status IN ('active','inactive'))",
    );
  }

  // is_system — backfill existing rows = 1 (they are all predefined system items)
  if (!(await has('is_system'))) {
    await knex.schema.alterTable('gym_charges', (t) => {
      t.tinyint('is_system').notNullable().defaultTo(0).after('status');
    });
    await knex.raw(`UPDATE gym_charges SET is_system = 1`);
  }

  // soft-delete columns
  if (!(await has('deleted_at'))) {
    await knex.schema.alterTable('gym_charges', (t) => {
      t.datetime('deleted_at').nullable();
    });
  }

  if (!(await has('deleted_by_membership_id'))) {
    await knex.schema.alterTable('gym_charges', (t) => {
      t.integer('deleted_by_membership_id').unsigned().nullable()
        .references('id').inTable('gym_memberships').onDelete('SET NULL');
    });
  }

  if (!(await has('deleted_by_name'))) {
    await knex.schema.alterTable('gym_charges', (t) => {
      t.string('deleted_by_name', 255).nullable();
    });
  }

  // type-specific fields for Sessions items
  if (!(await has('package_information'))) {
    await knex.schema.alterTable('gym_charges', (t) => {
      t.text('package_information').nullable();
    });
  }

  if (!(await has('validity_days'))) {
    await knex.schema.alterTable('gym_charges', (t) => {
      t.integer('validity_days').unsigned().nullable();
    });
  }

  // Extend billing_frequency CHECK to include 'per_session'
  await knex.raw(
    'ALTER TABLE gym_charges DROP CHECK gym_charges_billing_frequency_check',
  ).catch(() => {});
  if (!(await constraintExists('gym_charges_billing_frequency_check'))) {
    await knex.raw(
      'ALTER TABLE gym_charges ADD CONSTRAINT gym_charges_billing_frequency_check ' +
      "CHECK (billing_frequency IS NULL OR billing_frequency IN ('once','per_session','week','month','year'))",
    );
  }
};

exports.down = async (knex) => {
  const has = (col) => knex.schema.hasColumn('gym_charges', col);

  // Restore billing_frequency CHECK without 'per_session'
  await knex.raw(
    'ALTER TABLE gym_charges DROP CHECK gym_charges_billing_frequency_check',
  ).catch(() => {});
  await knex.raw(
    'ALTER TABLE gym_charges ADD CONSTRAINT gym_charges_billing_frequency_check ' +
    "CHECK (billing_frequency IS NULL OR billing_frequency IN ('once','week','month','year'))",
  ).catch(() => {});

  for (const col of ['validity_days', 'package_information', 'deleted_by_name', 'deleted_by_membership_id', 'deleted_at']) {
    if (await has(col)) {
      await knex.schema.alterTable('gym_charges', (t) => t.dropColumn(col));
    }
  }

  await knex.raw('ALTER TABLE gym_charges DROP CHECK gym_charges_status_check').catch(() => {});
  await knex.raw('ALTER TABLE gym_charges DROP CHECK gym_charges_units_check').catch(() => {});
  await knex.raw('ALTER TABLE gym_charges DROP CHECK gym_charges_type_check').catch(() => {});

  for (const col of ['is_system', 'status', 'units', 'type', 'name']) {
    if (await has(col)) {
      await knex.schema.alterTable('gym_charges', (t) => t.dropColumn(col));
    }
  }

  // Restore charge_type_id to NOT NULL (migration 103 down has already removed all custom rows)
  if (await has('charge_type_id')) {
    await knex.schema.alterTable('gym_charges', (t) => {
      t.integer('charge_type_id').unsigned().notNullable()
        .references('id').inTable('charge_types').onDelete('CASCADE')
        .alter();
    });
  }
};
