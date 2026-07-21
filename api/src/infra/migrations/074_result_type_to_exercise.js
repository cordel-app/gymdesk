/**
 * #154: Move result_type from block level to exercise instance level.
 * - workout_template_exercises: add result_type_id, target_value, min_value, max_value, unit
 *   drop duration_seconds, distance_value, distance_unit (superseded by result_type_id + target_value + unit)
 * - workout_exercises: same additions
 * - workout_template_blocks: drop result_type column
 * - workout_blocks: drop result_type column
 * - exercises: drop exercise_type column (superseded by exercise_allowed_result_types)
 *
 * Data migration: copy block.result_type down to each exercise instance using
 * the old→new slug mapping (Time→duration, Repetitions→repetitions, etc.).
 * None/Rounds/Score have no direct equivalent and are left NULL.
 */

// Maps the old block-level result_type values to new result_types slugs.
const OLD_TO_SLUG = {
  Time: 'duration',
  Repetitions: 'repetitions',
  Distance: 'distance',
  Calories: 'calories',
  Weight: 'weight',
};

exports.up = async (knex) => {
  // --- workout_template_exercises ---
  if (!(await knex.schema.hasColumn('workout_template_exercises', 'result_type_id'))) {
    await knex.schema.alterTable('workout_template_exercises', (t) => {
      t.integer('result_type_id').unsigned()
        .references('id').inTable('result_types').onDelete('SET NULL')
        .after('tempo');
      t.decimal('target_value', 10, 2).after('result_type_id');
      t.decimal('min_value', 10, 2).after('target_value');
      t.decimal('max_value', 10, 2).after('min_value');
      t.string('unit', 20).after('max_value');
    });

    // Migrate block result_type → exercise result_type_id
    for (const [oldVal, slug] of Object.entries(OLD_TO_SLUG)) {
      const [rtRows] = await knex.raw('SELECT id FROM result_types WHERE slug = ?', [slug]);
      if (rtRows.length === 0) continue;
      const rtId = rtRows[0].id;
      await knex.raw(
        `UPDATE workout_template_exercises wte
         JOIN workout_template_blocks wtb ON wtb.id = wte.workout_template_block_id
         SET wte.result_type_id = ?
         WHERE wtb.result_type = ? AND wte.result_type_id IS NULL`,
        [rtId, oldVal],
      );
    }

    // Migrate old distance_value/distance_unit → target_value/unit for distance exercises
    await knex.raw(
      `UPDATE workout_template_exercises
       SET target_value = distance_value, unit = distance_unit
       WHERE distance_value IS NOT NULL AND target_value IS NULL`,
    );
    // Migrate old duration_seconds → target_value (seconds) for duration exercises
    await knex.raw(
      `UPDATE workout_template_exercises wte
       JOIN result_types rt ON rt.id = wte.result_type_id AND rt.slug = 'duration'
       SET wte.target_value = wte.duration_seconds
       WHERE wte.duration_seconds IS NOT NULL AND wte.target_value IS NULL`,
    );
  }

  // Drop superseded columns from workout_template_exercises
  if (await knex.schema.hasColumn('workout_template_exercises', 'duration_seconds')) {
    await knex.schema.alterTable('workout_template_exercises', (t) => {
      t.dropColumn('duration_seconds');
      t.dropColumn('distance_value');
      t.dropColumn('distance_unit');
    });
  }

  // --- workout_exercises ---
  // Note: workout_exercises never had distance_value/distance_unit/duration_seconds —
  // those columns were only on workout_template_exercises (added in migration 071).
  if (!(await knex.schema.hasColumn('workout_exercises', 'result_type_id'))) {
    await knex.schema.alterTable('workout_exercises', (t) => {
      t.integer('result_type_id').unsigned()
        .references('id').inTable('result_types').onDelete('SET NULL')
        .after('tempo');
      t.decimal('target_value', 10, 2).after('result_type_id');
      t.decimal('min_value', 10, 2).after('target_value');
      t.decimal('max_value', 10, 2).after('min_value');
      t.string('unit', 20).after('max_value');
    });

    // Migrate block result_type → workout_exercise result_type_id
    for (const [oldVal, slug] of Object.entries(OLD_TO_SLUG)) {
      const [rtRows] = await knex.raw('SELECT id FROM result_types WHERE slug = ?', [slug]);
      if (rtRows.length === 0) continue;
      const rtId = rtRows[0].id;
      await knex.raw(
        `UPDATE workout_exercises we
         JOIN workout_blocks wb ON wb.id = we.workout_block_id
         SET we.result_type_id = ?
         WHERE wb.result_type = ? AND we.result_type_id IS NULL`,
        [rtId, oldVal],
      );
    }
  }

  // --- workout_template_blocks: drop result_type ---
  if (await knex.schema.hasColumn('workout_template_blocks', 'result_type')) {
    await knex.raw('ALTER TABLE workout_template_blocks DROP CHECK wtb_result_type_check').catch(() => {});
    await knex.schema.alterTable('workout_template_blocks', (t) => {
      t.dropColumn('result_type');
    });
  }

  // --- workout_blocks: drop result_type ---
  if (await knex.schema.hasColumn('workout_blocks', 'result_type')) {
    await knex.raw('ALTER TABLE workout_blocks DROP CHECK wb_result_type_check').catch(() => {});
    await knex.schema.alterTable('workout_blocks', (t) => {
      t.dropColumn('result_type');
    });
  }

  // --- exercises: drop exercise_type (superseded by exercise_allowed_result_types) ---
  if (await knex.schema.hasColumn('exercises', 'exercise_type')) {
    await knex.raw('ALTER TABLE exercises DROP CHECK exercises_exercise_type_check').catch(() => {});
    await knex.schema.alterTable('exercises', (t) => {
      t.dropColumn('exercise_type');
    });
  }
};

exports.down = async (knex) => {
  // Restore exercise_type on exercises
  if (!(await knex.schema.hasColumn('exercises', 'exercise_type'))) {
    await knex.schema.alterTable('exercises', (t) => {
      t.string('exercise_type', 20).notNullable().defaultTo('reps').after('name');
    });
    await knex.raw(
      "ALTER TABLE exercises ADD CONSTRAINT exercises_exercise_type_check " +
      "CHECK (exercise_type IN ('reps','time','distance'))",
    );
  }

  // Restore result_type on workout_template_blocks
  if (!(await knex.schema.hasColumn('workout_template_blocks', 'result_type'))) {
    await knex.schema.alterTable('workout_template_blocks', (t) => {
      t.string('result_type', 20).notNullable().defaultTo('None');
    });
    await knex.raw(
      "ALTER TABLE workout_template_blocks ADD CONSTRAINT wtb_result_type_check CHECK " +
      "(result_type IN ('None','Time','Rounds','Repetitions','Distance','Calories','Weight','Score'))",
    );
  }

  // Restore result_type on workout_blocks
  if (!(await knex.schema.hasColumn('workout_blocks', 'result_type'))) {
    await knex.schema.alterTable('workout_blocks', (t) => {
      t.string('result_type', 20).notNullable().defaultTo('None');
    });
    await knex.raw(
      "ALTER TABLE workout_blocks ADD CONSTRAINT wb_result_type_check CHECK " +
      "(result_type IN ('None','Time','Rounds','Repetitions','Distance','Calories','Weight','Score'))",
    );
  }

  // Restore duration_seconds/distance_value/distance_unit on workout_template_exercises
  if (!(await knex.schema.hasColumn('workout_template_exercises', 'duration_seconds'))) {
    await knex.schema.alterTable('workout_template_exercises', (t) => {
      t.integer('duration_seconds').unsigned().after('tempo');
      t.decimal('distance_value', 8, 2).unsigned().after('duration_seconds');
      t.string('distance_unit', 20).after('distance_value');
    });
  }

  // Drop new columns from workout_template_exercises
  if (await knex.schema.hasColumn('workout_template_exercises', 'result_type_id')) {
    await knex.schema.alterTable('workout_template_exercises', (t) => {
      t.dropColumn('result_type_id');
      t.dropColumn('target_value');
      t.dropColumn('min_value');
      t.dropColumn('max_value');
      t.dropColumn('unit');
    });
  }

  // Drop new columns from workout_exercises
  if (await knex.schema.hasColumn('workout_exercises', 'result_type_id')) {
    await knex.schema.alterTable('workout_exercises', (t) => {
      t.dropColumn('result_type_id');
      t.dropColumn('target_value');
      t.dropColumn('min_value');
      t.dropColumn('max_value');
      t.dropColumn('unit');
    });
  }
};
