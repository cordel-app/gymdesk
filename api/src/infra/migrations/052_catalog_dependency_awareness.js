/**
 * #62: dependency awareness + lifecycle cleanup for shared catalog entities.
 * - workout_templates gain a status enum (active/inactive/deleted); soft
 *   delete now sets status='deleted' alongside deleted_at.
 * - exercises gain deleted_at and a 'deleted' status value; the delete
 *   endpoint switches from hard DELETE to soft delete. The (gym_id, name)
 *   unique index is dropped (a soft-deleted row would block reusing its
 *   name) — uniqueness among non-deleted rows is enforced in the router.
 * - muscles become a static in-app catalog: exercise_muscles stores a
 *   muscle key (slug) instead of a FK and the muscles table is dropped.
 *   Existing links are preserved by slugifying the old muscle names.
 *
 * MySQL DDL is non-transactional, so every step is guarded to make the
 * migration re-runnable after a mid-way failure.
 */

async function indexExists(knex, table, indexName) {
  const [rows] = await knex.raw(
    `SELECT 1 FROM information_schema.statistics
      WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ? LIMIT 1`,
    [table, indexName],
  );
  return rows.length > 0;
}

exports.up = async (knex) => {
  // 1. workout_templates.status (CHECK added before the backfill so the
  //    'deleted' value passes it).
  if (!(await knex.schema.hasColumn('workout_templates', 'status'))) {
    await knex.schema.alterTable('workout_templates', (t) => {
      t.string('status', 20).notNullable().defaultTo('active');
    });
    await knex.raw(
      "ALTER TABLE workout_templates ADD CONSTRAINT workout_templates_status_check " +
      "CHECK (status IN ('active','inactive','deleted'))",
    );
    await knex.raw("UPDATE workout_templates SET status = 'deleted' WHERE deleted_at IS NOT NULL");
  }

  // 2. exercises: deleted_at + 'deleted' status value + drop name unique
  if (!(await knex.schema.hasColumn('exercises', 'deleted_at'))) {
    await knex.schema.alterTable('exercises', (t) => {
      t.datetime('deleted_at');
    });
    await knex.raw('ALTER TABLE exercises DROP CHECK exercises_status_check').catch(() => {});
    await knex.raw(
      "ALTER TABLE exercises ADD CONSTRAINT exercises_status_check " +
      "CHECK (status IN ('active','inactive','deleted'))",
    );
  }
  if (await indexExists(knex, 'exercises', 'exercises_gym_name_unique')) {
    await knex.schema.alterTable('exercises', (t) => {
      t.index(['gym_id', 'name'], 'exercises_gym_name_index');
      t.dropUnique(['gym_id', 'name'], 'exercises_gym_name_unique');
    });
  }

  // 3. static muscles: exercise_muscles.muscle (slug key) replaces muscle_id
  if (!(await knex.schema.hasColumn('exercise_muscles', 'muscle'))) {
    await knex.schema.alterTable('exercise_muscles', (t) => {
      t.string('muscle', 60);
    });
  }
  if (await knex.schema.hasColumn('exercise_muscles', 'muscle_id')) {
    await knex.raw(
      `UPDATE exercise_muscles em JOIN muscles m ON m.id = em.muscle_id
       SET em.muscle = LOWER(REPLACE(TRIM(m.name), ' ', '_'))`,
    );
    // Two old names can slugify to the same key — keep the oldest link.
    await knex.raw(
      `DELETE em FROM exercise_muscles em JOIN exercise_muscles dup
       ON dup.exercise_id = em.exercise_id AND dup.muscle = em.muscle AND dup.id < em.id`,
    );
    // The old (exercise_id, muscle_id) unique also backs the exercise_id FK,
    // so the replacement unique must exist before the old one is dropped.
    if (!(await indexExists(knex, 'exercise_muscles', 'exercise_muscles_ex_muscle_unique'))) {
      await knex.schema.alterTable('exercise_muscles', (t) => {
        t.unique(['exercise_id', 'muscle'], 'exercise_muscles_ex_muscle_unique');
      });
    }
    await knex.schema.alterTable('exercise_muscles', (t) => {
      t.dropForeign(['muscle_id']);
    });
    await knex.schema.alterTable('exercise_muscles', (t) => {
      t.dropUnique(['exercise_id', 'muscle_id'], 'exercise_muscles_unique_pair');
      t.dropColumn('muscle_id');
    });
    await knex.raw('ALTER TABLE exercise_muscles MODIFY muscle VARCHAR(60) NOT NULL');
  }
  await knex.schema.dropTableIfExists('muscles');
};

exports.down = async (knex) => {
  // Lossy: rebuilds the muscles table from the slug keys still on the links
  // (names come back slugified, not in their original casing).
  if (!(await knex.schema.hasTable('muscles'))) {
    await knex.schema.createTable('muscles', (t) => {
      t.increments('id').primary();
      t.specificType('gym_id', 'char(36)').notNullable()
        .references('id').inTable('gyms').onDelete('CASCADE');
      t.string('name', 120).notNullable();
      t.datetime('created_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP'));
      t.unique(['gym_id', 'name'], 'muscles_gym_name_unique');
    });
    await knex.raw('INSERT INTO muscles (gym_id, name) SELECT DISTINCT gym_id, muscle FROM exercise_muscles');
  }
  if (await knex.schema.hasColumn('exercise_muscles', 'muscle')) {
    await knex.schema.alterTable('exercise_muscles', (t) => {
      t.integer('muscle_id').unsigned();
    });
    await knex.raw(
      `UPDATE exercise_muscles em JOIN muscles m ON m.gym_id = em.gym_id AND m.name = em.muscle
       SET em.muscle_id = m.id`,
    );
    await knex.raw('ALTER TABLE exercise_muscles MODIFY muscle_id INT UNSIGNED NOT NULL');
    await knex.schema.alterTable('exercise_muscles', (t) => {
      t.foreign('muscle_id').references('id').inTable('muscles').onDelete('CASCADE');
      t.unique(['exercise_id', 'muscle_id'], 'exercise_muscles_unique_pair');
    });
    await knex.schema.alterTable('exercise_muscles', (t) => {
      t.dropUnique(['exercise_id', 'muscle'], 'exercise_muscles_ex_muscle_unique');
      t.dropColumn('muscle');
    });
  }

  await knex.raw("UPDATE exercises SET status = 'inactive' WHERE status = 'deleted'");
  await knex.raw('ALTER TABLE exercises DROP CHECK exercises_status_check').catch(() => {});
  await knex.raw(
    "ALTER TABLE exercises ADD CONSTRAINT exercises_status_check " +
    "CHECK (status IN ('active','inactive'))",
  );
  if (await knex.schema.hasColumn('exercises', 'deleted_at')) {
    await knex.schema.alterTable('exercises', (t) => {
      t.dropColumn('deleted_at');
      t.unique(['gym_id', 'name'], 'exercises_gym_name_unique');
      t.dropIndex(['gym_id', 'name'], 'exercises_gym_name_index');
    });
  }

  await knex.raw('ALTER TABLE workout_templates DROP CHECK workout_templates_status_check').catch(() => {});
  if (await knex.schema.hasColumn('workout_templates', 'status')) {
    await knex.schema.alterTable('workout_templates', (t) => {
      t.dropColumn('status');
    });
  }
};
