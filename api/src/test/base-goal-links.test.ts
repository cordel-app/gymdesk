// #1849 stages 2d-2f: a System Personal Goal is referenced through
// base_personal_goal_id alone; a gym-owned goal through personal_goal_id alone.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { baseGoalLinkChecks } from '../domain/baseGoalLinkAudit';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';

let gym: string;
let member: number;
let systemId: number;
let ownId: number;
const h = () => ({ Authorization: TEST_AUTH_HEADER, 'x-gym-id': gym });

async function auditCounts() {
  const { checks, params } = baseGoalLinkChecks(gym);
  const out: Record<string, number> = {};
  for (const [i, c] of checks.entries()) {
    const { rows } = await db.query<{ n: number }>(c.sql, params[i]);
    out[c.key] = Number(rows[0].n);
  }
  return out;
}

beforeAll(async () => {
  gym = await createTestGym();
  await createTestMembership(gym, 'admin');
  const m = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)', [gym, 'Link Member', 'link@example.com']);
  member = m.insertId as number;
  const { rows } = await db.query<any>("SELECT id FROM base_personal_goals WHERE slug = 'maintenance'");
  systemId = rows[0].id;
  const own = await db.query("INSERT INTO personal_goals (gym_id, name, status) VALUES (?, 'Test Link Own Goal', 'active')", [gym]);
  ownId = own.insertId as number;
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('schema (#1849 2d/2f)', () => {
  it('both tables reference Base goals RESTRICT and gym-owned goals CASCADE', async () => {
    const { rows } = await db.query<any>(
      `SELECT k.TABLE_NAME AS t, k.COLUMN_NAME AS c, r.DELETE_RULE AS rule
         FROM information_schema.KEY_COLUMN_USAGE k
         JOIN information_schema.REFERENTIAL_CONSTRAINTS r
           ON r.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND r.CONSTRAINT_SCHEMA = k.TABLE_SCHEMA
        WHERE k.TABLE_SCHEMA = DATABASE() AND k.TABLE_NAME IN ('member_personal_goals','gym_personal_goals')
          AND k.REFERENCED_TABLE_NAME IN ('base_personal_goals','personal_goals')`,
    );
    for (const t of ['member_personal_goals', 'gym_personal_goals']) {
      expect(rows.find((r: any) => r.t === t && r.c === 'base_personal_goal_id')?.rule).toBe('RESTRICT');
      expect(rows.find((r: any) => r.t === t && r.c === 'personal_goal_id')?.rule).toBe('CASCADE');
    }
  });

  it('the exactly-one CHECK rejects both columns set and neither', async () => {
    for (const [a, b] of [[ownId, systemId], [null, null]]) {
      await expect(db.query(
        'INSERT INTO gym_personal_goals (gym_id, personal_goal_id, base_personal_goal_id, status) VALUES (?, ?, ?, ?)',
        [gym, a, b, 'active'],
      )).rejects.toThrow();
      await expect(db.query(
        'INSERT INTO member_personal_goals (gym_id, member_id, personal_goal_id, base_personal_goal_id, goal_name) VALUES (?, ?, ?, ?, ?)',
        [gym, member, a, b, 'x'],
      )).rejects.toThrow();
    }
  });

  it('a referenced Base goal cannot be hard-deleted (RESTRICT)', async () => {
    await db.query('INSERT INTO gym_personal_goals (gym_id, base_personal_goal_id, status) VALUES (?, ?, ?)', [gym, systemId, 'active']);
    await expect(db.query('DELETE FROM base_personal_goals WHERE id = ?', [systemId])).rejects.toThrow();
    await db.query('DELETE FROM gym_personal_goals WHERE gym_id = ?', [gym]);
  });

  it('the activation key is unique per gym and goal whichever column carries it', async () => {
    await db.query('INSERT INTO gym_personal_goals (gym_id, base_personal_goal_id, status) VALUES (?, ?, ?)', [gym, systemId, 'active']);
    await expect(db.query('INSERT INTO gym_personal_goals (gym_id, base_personal_goal_id, status) VALUES (?, ?, ?)', [gym, systemId, 'inactive'])).rejects.toThrow();
    await db.query('INSERT INTO gym_personal_goals (gym_id, personal_goal_id, status) VALUES (?, ?, ?)', [gym, ownId, 'active']);
    await expect(db.query('INSERT INTO gym_personal_goals (gym_id, personal_goal_id, status) VALUES (?, ?, ?)', [gym, ownId, 'inactive'])).rejects.toThrow();
    await db.query('DELETE FROM gym_personal_goals WHERE gym_id = ?', [gym]);
  });
});

describe('writers and readers (#1849 2e/2f)', () => {
  it('assigning a System goal stores only the Base reference; an own goal only the gym one', async () => {
    const res = await request.post('/member-personal-goals').set(h()).send({ member_id: member, personal_goal_id: systemId });
    expect(res.status).toBe(201);
    expect(res.body.personal_goal_id).toBe(systemId);
    const res2 = await request.post('/member-personal-goals').set(h()).send({ member_id: member, personal_goal_id: ownId });
    expect(res2.status).toBe(201);
    const { rows } = await db.query<any>(
      'SELECT personal_goal_id, base_personal_goal_id FROM member_personal_goals WHERE gym_id = ? ORDER BY id', [gym]);
    expect(rows[0]).toEqual({ personal_goal_id: null, base_personal_goal_id: systemId });
    expect(rows[1]).toEqual({ personal_goal_id: ownId, base_personal_goal_id: null });
  });

  it('a second live assignment of the same System goal is refused (the unique key follows the Base column)', async () => {
    const res = await request.post('/member-personal-goals').set(h()).send({ member_id: member, personal_goal_id: systemId });
    expect(res.status).toBe(409);
  });

  it('the member and staff lists still return both goals under personal_goal_id', async () => {
    const res = await request.get('/member-personal-goals').set(h()).query({ member_id: member });
    expect(res.status).toBe(200);
    expect(res.body.items.map((g: any) => g.personal_goal_id).sort()).toEqual([systemId, ownId].sort());
  });

  it('deactivating a System goal stores the Base reference only, and is idempotent', async () => {
    const { rows } = await db.query<any>("SELECT id FROM base_personal_goals WHERE slug = 'energy'");
    const sys = rows[0].id;
    for (let i = 0; i < 2; i += 1) {
      expect((await request.post(`/personal-goals/${sys}/deactivate`).set(h())).status).toBeLessThan(300);
    }
    const { rows: g } = await db.query<any>(
      'SELECT status, personal_goal_id, base_personal_goal_id FROM gym_personal_goals WHERE gym_id = ? AND base_personal_goal_id = ?', [gym, sys]);
    expect(g).toEqual([{ status: 'inactive', personal_goal_id: null, base_personal_goal_id: sys }]);
  });

  it('a System goal reads its translations from the Base table', async () => {
    const { rows } = await db.query<any>("SELECT id FROM base_personal_goals WHERE slug = 'recovery'");
    const sys = rows[0].id;
    await db.query(
      `INSERT INTO base_personal_goal_translations (base_personal_goal_id, locale, name) VALUES (?, 'es', 'Solo Base 2e')
       ON DUPLICATE KEY UPDATE name = 'Solo Base 2e'`, [sys]);
    const list = await request.get('/personal-goals').set(h()).set('x-locale', 'es').query({ search: 'recovery' });
    expect(list.body.items.find((g: any) => g.id === sys).display_name).toBe('Solo Base 2e');
    await db.query("UPDATE base_personal_goal_translations SET name = 'Recuperación' WHERE base_personal_goal_id = ? AND locale = 'es'", [sys]);
  });

  it('the audit is clean for this gym', async () => {
    const counts = await auditCounts();
    expect(counts).toMatchObject({
      assignment_not_exactly_one: 0, assignment_goal_unknown: 0, assignment_references_legacy_system_goal: 0,
      activation_not_exactly_one: 0, activation_goal_unknown: 0, activation_references_legacy_system_goal: 0,
    });
  });
});
