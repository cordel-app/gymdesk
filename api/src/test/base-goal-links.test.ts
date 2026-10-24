// #1849 stage 2d: migration 316 adds base_personal_goal_id to member_personal_goals
// and gym_personal_goals, backfills it for System goals and keeps everything else.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { baseGoalLinkChecks } from '../domain/baseGoalLinkAudit';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';

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

describe('writers and readers use base_personal_goal_id (#1849 stage 2e)', () => {
  let gym: string;
  let member: number;
  const h = () => ({ Authorization: TEST_AUTH_HEADER, 'x-gym-id': gym });

  beforeAll(async () => {
    gym = await createTestGym();
    await createTestMembership(gym, 'admin');
    const m = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)', [gym, 'Link Member 2e', 'link2e@example.com']);
    member = m.insertId as number;
  });

  it('assigning a System goal links the Base row; a gym-owned goal gets no Base link', async () => {
    const { rows } = await db.query<any>("SELECT id FROM base_personal_goals WHERE slug = 'maintenance'");
    const sys = rows[0].id;
    const res = await request.post('/member-personal-goals').set(h()).send({ member_id: member, personal_goal_id: sys });
    expect(res.status).toBe(201);
    expect(res.body.personal_goal_id).toBe(sys);
    const own = await db.query("INSERT INTO personal_goals (gym_id, name, status) VALUES (?, 'Test Link Own 2e', 'active')", [gym]);
    const res2 = await request.post('/member-personal-goals').set(h()).send({ member_id: member, personal_goal_id: own.insertId });
    expect(res2.status).toBe(201);
    const { rows: links } = await db.query<any>(
      'SELECT personal_goal_id, base_personal_goal_id FROM member_personal_goals WHERE gym_id = ? ORDER BY id', [gym]);
    expect(links[0].base_personal_goal_id).toBe(sys);
    expect(links[1].base_personal_goal_id).toBeNull();
  });

  it('activating and deactivating a System goal links the Base row', async () => {
    const { rows } = await db.query<any>("SELECT id FROM base_personal_goals WHERE slug = 'energy'");
    const sys = rows[0].id;
    expect((await request.post(`/personal-goals/${sys}/deactivate`).set(h())).status).toBeLessThan(300);
    const { rows: g } = await db.query<any>(
      'SELECT status, base_personal_goal_id FROM gym_personal_goals WHERE gym_id = ? AND personal_goal_id = ?', [gym, sys]);
    expect(g[0]).toMatchObject({ status: 'inactive', base_personal_goal_id: sys });
  });

  it('a System goal reads its translations from the Base table, not the legacy copy', async () => {
    const { rows } = await db.query<any>("SELECT id FROM base_personal_goals WHERE slug = 'recovery'");
    const sys = rows[0].id;
    await db.query(
      `INSERT INTO base_personal_goal_translations (base_personal_goal_id, locale, name) VALUES (?, 'es', 'Solo Base 2e')
       ON DUPLICATE KEY UPDATE name = 'Solo Base 2e'`, [sys]);
    const list = await request.get('/personal-goals').set(h()).set('x-locale', 'es').query({ search: 'recovery' });
    const goal = list.body.items.find((g: any) => g.id === sys);
    expect(goal.translations.es.name).toBe('Solo Base 2e');
    expect(goal.display_name).toBe('Solo Base 2e');
    await db.query("UPDATE base_personal_goal_translations SET name = 'Recuperación' WHERE base_personal_goal_id = ? AND locale = 'es'", [sys]);
  });
});
