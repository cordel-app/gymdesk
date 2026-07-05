/**
 * P1.1 (#5): evolve fares into membership_plans.
 * Pure rename + additive columns — zero data loss, fully reversible.
 * MySQL DDL is non-transactional: statements ordered so a mid-failure
 * leaves a state the down() can still reason about.
 */

exports.up = async (knex) => {
  await knex.schema.renameTable('fares', 'membership_plans');

  await knex.schema.alterTable('membership_plans', (t) => {
    t.renameColumn('price', 'base_price');
  });

  await knex.schema.alterTable('membership_plans', (t) => {
    t.text('description');
    t.string('status', 20).notNullable().defaultTo('active');
  });

  // De-duplicate names per gym before the unique index (keeps the oldest,
  // suffixes the rest with their id — e.g. "Standard (3)")
  await knex.raw(`
    UPDATE membership_plans p
    JOIN (
      SELECT gym_id, name, MIN(id) AS keep_id
      FROM membership_plans
      GROUP BY gym_id, name
      HAVING COUNT(*) > 1
    ) d ON p.gym_id = d.gym_id AND p.name = d.name AND p.id <> d.keep_id
    SET p.name = CONCAT(p.name, ' (', p.id, ')')
  `);

  await knex.schema.alterTable('membership_plans', (t) => {
    t.unique(['gym_id', 'name'], { indexName: 'membership_plans_gym_name_unique' });
  });
  await knex.raw(
    "ALTER TABLE membership_plans ADD CONSTRAINT membership_plans_status_check CHECK (status IN ('active','inactive'))",
  );

  await knex.schema.alterTable('members', (t) => {
    t.renameColumn('fare_id', 'membership_plan_id');
  });
};

// Guarded so it completes from any partial state (MySQL DDL is non-transactional).
// Note: names de-duplicated by up() keep their "(id)" suffix — data change, not reversed.
exports.down = async (knex) => {
  if (await knex.schema.hasColumn('members', 'membership_plan_id')) {
    await knex.schema.alterTable('members', (t) => {
      t.renameColumn('membership_plan_id', 'fare_id');
    });
  }

  await knex.raw('ALTER TABLE membership_plans DROP CHECK membership_plans_status_check').catch(() => {});

  const [idx] = await knex.raw(
    "SHOW INDEX FROM membership_plans WHERE Key_name = 'membership_plans_gym_name_unique'",
  );
  if (idx.length > 0) {
    // The composite unique became the index backing the gym_id FK (MySQL dropped
    // the original as redundant) — provide a replacement before dropping it.
    const [gymIdx] = await knex.raw(
      "SHOW INDEX FROM membership_plans WHERE Column_name = 'gym_id' AND Seq_in_index = 1 AND Key_name <> 'membership_plans_gym_name_unique'",
    );
    if (gymIdx.length === 0) {
      await knex.schema.alterTable('membership_plans', (t) => {
        t.index('gym_id', 'membership_plans_gym_id_index');
      });
    }
    await knex.schema.alterTable('membership_plans', (t) => {
      t.dropUnique(['gym_id', 'name'], 'membership_plans_gym_name_unique');
    });
  }
  if (await knex.schema.hasColumn('membership_plans', 'status')) {
    await knex.schema.alterTable('membership_plans', (t) => t.dropColumn('status'));
  }
  if (await knex.schema.hasColumn('membership_plans', 'description')) {
    await knex.schema.alterTable('membership_plans', (t) => t.dropColumn('description'));
  }
  if (await knex.schema.hasColumn('membership_plans', 'base_price')) {
    await knex.schema.alterTable('membership_plans', (t) => {
      t.renameColumn('base_price', 'price');
    });
  }
  if (await knex.schema.hasTable('membership_plans')) {
    await knex.schema.renameTable('membership_plans', 'fares');
  }
};
