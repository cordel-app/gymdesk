/**
 * #2125 stage 3 — a member may hold several Membership Plans again.
 *
 * Reverses #956 (migration 213): the UNIQUE index `user_memberships_one_active`
 * on the generated `active_member_key` is dropped, and the column with it —
 * nothing reads it any more, the rule it served lives in `findLiveAssignments…`
 * as "ask Add or Replace" and not as a refusal.
 *
 * `replace_on_activation` carries the staff's Add-or-Replace answer across Save &
 * Pay: the answer is taken when the Draft is submitted, but the supersede happens
 * when the money arrives (webhook / record-payment), and those callers have no
 * request body to read it from. 0 (the default) = add, 1 = replace.
 *
 * MySQL DDL is non-transactional, so each step is guarded independently.
 */

const TABLE = 'user_memberships';
const INDEX = 'user_memberships_one_active';

async function indexExists(knex, name) {
  const [rows] = await knex.raw(`SHOW INDEX FROM ${TABLE} WHERE Key_name = ?`, [name]);
  return rows.length > 0;
}

exports.up = async (knex) => {
  if (await indexExists(knex, INDEX)) {
    await knex.raw(`ALTER TABLE ${TABLE} DROP INDEX ${INDEX}`);
  }
  if (await knex.schema.hasColumn(TABLE, 'active_member_key')) {
    await knex.raw(`ALTER TABLE ${TABLE} DROP COLUMN active_member_key`);
  }
  if (!(await knex.schema.hasColumn(TABLE, 'replace_on_activation'))) {
    await knex.raw(
      `ALTER TABLE ${TABLE} ADD COLUMN replace_on_activation TINYINT(1) NOT NULL DEFAULT 0`,
    );
  }
};

exports.down = async (knex) => {
  const [pendingReplace] = await knex.raw(
    `SELECT COUNT(*) AS n FROM ${TABLE} WHERE replace_on_activation = 1`,
  );
  if (Number(pendingReplace[0]?.n ?? 0) > 0) {
    console.warn(
      `Rolling back 349 drops replace_on_activation: ${pendingReplace[0].n} assignment(s) `
      + 'carry a "replace" answer that a re-run will read as "add".',
    );
  }
  const [conflicts] = await knex.raw(
    `SELECT member_id, COUNT(*) AS n FROM ${TABLE}
     WHERE status = 'active' GROUP BY member_id HAVING n > 1`,
  );
  if (conflicts.length > 0) {
    throw new Error(
      `Cannot roll back 349: ${conflicts.length} member(s) hold more than one active membership `
      + `(member_id: ${conflicts.map((r) => r.member_id).join(', ')}). Cancel the extras first.`,
    );
  }
  if (await knex.schema.hasColumn(TABLE, 'replace_on_activation')) {
    await knex.raw(`ALTER TABLE ${TABLE} DROP COLUMN replace_on_activation`);
  }
  if (!(await knex.schema.hasColumn(TABLE, 'active_member_key'))) {
    await knex.raw(
      `ALTER TABLE ${TABLE} ADD COLUMN active_member_key INT UNSIGNED
         GENERATED ALWAYS AS (IF(status = 'active', member_id, NULL)) VIRTUAL`,
    );
  }
  if (!(await indexExists(knex, INDEX))) {
    await knex.raw(`ALTER TABLE ${TABLE} ADD UNIQUE KEY ${INDEX} (active_member_key)`);
  }
};
