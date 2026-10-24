// #1849 stage 2d: migration 316 adds base_personal_goal_id to member_personal_goals
// and gym_personal_goals, backfills it for System goals and keeps everything else.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { baseGoalLinkChecks } from '../domain/baseGoalLinkAudit';
import { cleanupTestGyms, createTestGym } from './helpers';

let gymId: string;
let memberId: number;
let systemId: number;
let gymGoalId: number;

async function auditCounts() {
  const { checks, params } = baseGoalLinkChecks(gymId);
  const out: Record<string, number> = {};
  for (const [i, c] of checks.entries()) {
    const { rows } = await db.query<{ n: number }>(c.sql, params[i]);
    out[c.key] = Number(rows[0].n);
  }
  return out;
}

beforeAll(async () => {
  gymId = await createTestGym();
  const m = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)', [gymId, 'Link Member', 'link@example.com']);
  memberId = m.insertId as number;
  const { rows } = await db.query<any>("SELECT id FROM base_personal_goals WHERE slug = 'weight_loss'");
  systemId = rows[0].id;
  const { insertId } = await db.query(
    "INSERT INTO personal_goals (gym_id, name, status) VALUES (?, 'Test Link Own Goal', 'active')", [gymId]);
  gymGoalId = insertId as number;
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('base_personal_goal_id (#1849 stage 2d)', () => {
  it('exists on both tables with an ON DELETE RESTRICT FK to base_personal_goals', async () => {
    const { rows } = await db.query<any>(
      `SELECT k.TABLE_NAME AS t, r.DELETE_RULE AS rule
         FROM information_schema.KEY_COLUMN_USAGE k
         JOIN information_schema.REFERENTIAL_CONSTRAINTS r
           ON r.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND r.CONSTRAINT_SCHEMA = k.TABLE_SCHEMA
        WHERE k.TABLE_SCHEMA = DATABASE() AND k.COLUMN_NAME = 'base_personal_goal_id'
          AND k.REFERENCED_TABLE_NAME = 'base_personal_goals'
          AND k.TABLE_NAME IN ('member_personal_goals','gym_personal_goals')`,
    );
    expect(rows.map((r: any) => r.t).sort()).toEqual(['gym_personal_goals', 'member_personal_goals']);
    expect(rows.every((r: any) => r.rule === 'RESTRICT')).toBe(true);
  });

  it('leaves personal_goal_id and its cascade FK untouched', async () => {
    const { rows } = await db.query<any>(
      `SELECT k.TABLE_NAME AS t, r.DELETE_RULE AS rule
         FROM information_schema.KEY_COLUMN_USAGE k
         JOIN information_schema.REFERENTIAL_CONSTRAINTS r
           ON r.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND r.CONSTRAINT_SCHEMA = k.TABLE_SCHEMA
        WHERE k.TABLE_SCHEMA = DATABASE() AND k.COLUMN_NAME = 'personal_goal_id'
          AND k.REFERENCED_TABLE_NAME = 'personal_goals'
          AND k.TABLE_NAME IN ('member_personal_goals','gym_personal_goals')`,
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((r: any) => r.rule === 'CASCADE')).toBe(true);
  });

  it('the audit flags an unlinked System assignment and passes once backfilled', async () => {
    await db.query(
      `INSERT INTO member_personal_goals (gym_id, member_id, personal_goal_id, goal_name, created_by)
       VALUES (?, ?, ?, 'x', 'test'), (?, ?, ?, 'y', 'test')`,
      [gymId, memberId, systemId, gymId, memberId, gymGoalId],
    );
    await db.query(
      'INSERT INTO gym_personal_goals (gym_id, personal_goal_id, status, created_by) VALUES (?, ?, ?, ?)',
      [gymId, systemId, 'active', 'test'],
    );
    const before = await auditCounts();
    expect(before.assignment_system_unlinked).toBe(1);
    expect(before.activation_system_unlinked).toBe(1);

    // The migration's backfill statement, as stage 2e will re-run it.
    for (const table of ['member_personal_goals', 'gym_personal_goals']) {
      await db.query(
        `UPDATE ${table} t JOIN personal_goals p ON p.id = t.personal_goal_id AND p.gym_id IS NULL
            SET t.base_personal_goal_id = p.id WHERE t.base_personal_goal_id IS NULL`,
      );
    }
    const after = await auditCounts();
    expect(after).toMatchObject({
      assignment_system_unlinked: 0, assignment_link_mismatch: 0,
      activation_system_unlinked: 0, activation_link_mismatch: 0, assignment_goal_unknown: 0,
    });
    const { rows } = await db.query<any>(
      'SELECT personal_goal_id, base_personal_goal_id FROM member_personal_goals WHERE gym_id = ? ORDER BY id', [gymId]);
    expect(rows[0].base_personal_goal_id).toBe(rows[0].personal_goal_id);
    expect(rows[1].base_personal_goal_id).toBeNull(); // a gym-owned goal never gets one
  });

  it('a referenced Base goal cannot be hard-deleted (RESTRICT), so it never cascades into assignments', async () => {
    await expect(db.query('DELETE FROM base_personal_goals WHERE id = ?', [systemId])).rejects.toThrow();
  });
});
