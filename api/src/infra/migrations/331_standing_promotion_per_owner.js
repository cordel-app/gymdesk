/**
 * #1991 stage 3: one standing application of a Promotion per *owner* of the
 * version. Migration 248 made it one per (version, Promotion); a Product-target
 * application is owned by a line (330), and two independent lines of one Product
 * may each carry the same Promotion. A Plan application (no line) keeps the old
 * shape because the line part is 0.
 *
 * Re-entrant: DDL is not transactional, so each step checks what is already in
 * place and a run that stopped half way is completed by the next one.
 */
const TABLE = 'user_membership_promotions';
const KEY = 'ump_one_standing_per_set_promotion';
const COLUMN = 'standing_set_promotion_key';

const WIDE = `IF(status = 'applied' AND product_set_id IS NOT NULL,
         CONCAT(product_set_id, ':', promotion_id, ':', COALESCE(recurrent_snapshot_id, 0)), NULL)`;
const NARROW = `IF(status = 'applied' AND product_set_id IS NOT NULL, CONCAT(product_set_id, ':', promotion_id), NULL)`;

const hasIndex = async (knex) => {
  const [rows] = await knex.raw(
    `SELECT 1 FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1`, [TABLE, KEY]);
  return rows.length > 0;
};

const generation = async (knex) => {
  const [rows] = await knex.raw(
    `SELECT GENERATION_EXPRESSION AS expr FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`, [TABLE, COLUMN]);
  return rows.length ? String(rows[0].expr ?? '') : null;
};

const swap = async (knex, expression, width, wanted) => {
  const current = await generation(knex);
  if (current !== null && wanted(current) && (await hasIndex(knex))) return;
  if (await hasIndex(knex)) await knex.raw(`ALTER TABLE ${TABLE} DROP INDEX ${KEY}`);
  if (current !== null) await knex.raw(`ALTER TABLE ${TABLE} DROP COLUMN ${COLUMN}`);
  await knex.raw(
    `ALTER TABLE ${TABLE}
       ADD COLUMN ${COLUMN} VARCHAR(${width}) GENERATED ALWAYS AS (${expression}) VIRTUAL,
       ADD UNIQUE KEY ${KEY} (${COLUMN})`);
};

exports.up = (knex) => swap(knex, WIDE, 40, (expr) => expr.includes('recurrent_snapshot_id'));
exports.down = (knex) => swap(knex, NARROW, 32, (expr) => !expr.includes('recurrent_snapshot_id'));
