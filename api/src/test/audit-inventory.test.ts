import { afterAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { AUDITED_TABLES } from '../domain/auditActor';
import { AUDIT_INVENTORY } from '../domain/auditInventory';

/**
 * #1182 stage 4 — the acceptance matrix. Every base table of the live schema is
 * classified, and every table classified `audited` really carries the columns
 * its lifecycle has.
 */
describe('audit inventory (#1182)', () => {
  afterAll(async () => { await db.end(); });

  async function tables(): Promise<string[]> {
    const { rows } = await db.query<{ table_name: string }>(
      `SELECT table_name AS table_name FROM information_schema.tables
        WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE' AND table_name NOT LIKE 'knex%'`);
    return rows.map((r) => r.table_name);
  }

  it('classifies every base table exactly once', async () => {
    const unclassified = (await tables()).filter(
      (t) => !AUDITED_TABLES.includes(t) && !(t in AUDIT_INVENTORY));
    expect(unclassified).toEqual([]);
    expect(AUDITED_TABLES.filter((t) => t in AUDIT_INVENTORY)).toEqual([]);
    const all = await tables();
    // A legacy table may be absent on a database migrated from scratch (or present
    // on one migrated from an older schema), so only live classes must exist.
    expect(Object.keys(AUDIT_INVENTORY)
      .filter((t) => AUDIT_INVENTORY[t][0] !== 'legacy' && !all.includes(t))).toEqual([]);
  });

  it('gives an audited table the text columns its lifecycle has', async () => {
    const offenders: string[] = [];
    for (const table of AUDITED_TABLES) {
      const { rows } = await db.query<{ c: string }>(
        `SELECT column_name AS c FROM information_schema.columns
          WHERE table_schema = DATABASE() AND table_name = ?`, [table]);
      const cols = new Set(rows.map((r) => r.c));
      if (!cols.has('created_by') && !cols.has('modified_by')) offenders.push(`${table}: no actor column`);
      for (const old of ['created_by_name', 'modified_by_name', 'deleted_by_name', 'created_by_type',
        'modified_by_type', 'deleted_by_type']) {
        if (cols.has(old)) offenders.push(`${table}: still has ${old}`);
      }
      if (cols.has('deleted_at') && !cols.has('deleted_by')) offenders.push(`${table}: deleted_at without deleted_by`);
      if (cols.has('modified_at') && !cols.has('modified_by')) offenders.push(`${table}: modified_at without modified_by`);
    }
    expect(offenders).toEqual([]);
  });
});
