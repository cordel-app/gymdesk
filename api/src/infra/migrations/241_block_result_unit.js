/**
 * #1232 — a workout block's global result unit.
 *
 * `result_unit` on both block tables says what a Circuit / EMOM / AMRAP /
 * Tabata block records ("rounds", "minutes", …); NULL means no global result,
 * which is what every existing block keeps. `workout_block_logs.result_unit`
 * snapshots the unit at the time the result was recorded so it stays
 * interpretable after the block is reconfigured. No CHECKs (`ADD CONSTRAINT`
 * rebuilds under ALGORITHM=COPY): the vocabulary is
 * `api/src/domain/blockResultUnits.ts`.
 */
const TABLES = ['workout_template_blocks', 'workout_blocks', 'workout_block_logs'];

exports.up = async (knex) => {
  for (const table of TABLES) {
    if (!(await knex.schema.hasColumn(table, 'result_unit'))) {
      await knex.raw(`ALTER TABLE ${table} ADD COLUMN result_unit VARCHAR(16) NULL`);
    }
  }
};

exports.down = async (knex) => {
  for (const table of [...TABLES].reverse()) {
    if (await knex.schema.hasColumn(table, 'result_unit')) {
      await knex.raw(`ALTER TABLE ${table} DROP COLUMN result_unit`);
    }
  }
};
