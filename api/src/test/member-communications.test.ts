// #1390 — POST /members/:id/communications: one Member, the role gate, the
// feature flag, tenant isolation and the alert reaching only that Member.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { invalidateFeatureFlagsCache } from '../infra/featureFlags';
import {
  TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request,
} from './helpers';

const FLAG = 'membership.staff_communications';
let gymId: string;
let otherGymId: string;
let accountantGymId: string;
let trainerGymId: string;
let nutritionistGymId: string;
let memberId: number;
let otherMemberId: number;
let deletedMemberId: number;

const h = (gid: string) => ({ Authorization: TEST_AUTH_HEADER, 'x-gym-id': gid });
const body = { title: 'Welcome', message: 'Your plan is ready.' };

async function seedMember(gid: string, label: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)`,
    [gid, label, `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.com`],
  );
  return insertId;
}

async function rows(gid: string, mid: number) {
  const { rows: r } = await db.query(
    `SELECT type, payload FROM member_notifications WHERE gym_id = ? AND member_id = ? AND type = 'staff_message'`,
    [gid, mid],
  );
  return r;
}

beforeAll(async () => {
  gymId = await createTestGym('MemComm Gym');
  otherGymId = await createTestGym('MemComm Other Gym');
  accountantGymId = await createTestGym('MemComm Accountant Gym');
  trainerGymId = await createTestGym('MemComm Trainer Gym');
  nutritionistGymId = await createTestGym('MemComm Nutritionist Gym');
  await createTestMembership(gymId, 'admin');
  await createTestMembership(otherGymId, 'admin');
  await createTestMembership(accountantGymId, 'accountant');
  await createTestMembership(trainerGymId, 'trainer_performance');
  await createTestMembership(nutritionistGymId, 'nutritionist');
  memberId = await seedMember(gymId, 'target');
  otherMemberId = await seedMember(gymId, 'bystander');
  deletedMemberId = await seedMember(gymId, 'gone');
  await db.query('UPDATE members SET deleted_at = UTC_TIMESTAMP() WHERE id = ?', [deletedMemberId]);
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('POST /members/:id/communications', () => {
  it('401 when unauthenticated', async () => {
    const res = await request.post(`/members/${memberId}/communications`).set('x-gym-id', gymId).send(body);
    expect(res.status).toBe(401);
  });

  it('403 for a role without access', async () => {
    const mid = await seedMember(accountantGymId, 'acc');
    const res = await request.post(`/members/${mid}/communications`).set(h(accountantGymId)).send(body);
    expect(res.status).toBe(403);
  });

  it('404 for another gym\'s member, a deleted member and an unknown id', async () => {
    expect((await request.post(`/members/${memberId}/communications`).set(h(otherGymId)).send(body)).status).toBe(404);
    expect((await request.post(`/members/${deletedMemberId}/communications`).set(h(gymId)).send(body)).status).toBe(404);
    expect((await request.post(`/members/999999999/communications`).set(h(gymId)).send(body)).status).toBe(404);
    expect((await rows(gymId, memberId)).length).toBe(0);
  });

  it('400 on a blank or missing title or message', async () => {
    for (const b of [{ title: '  ', message: 'x' }, { title: 'x', message: '' }, {}]) {
      const res = await request.post(`/members/${memberId}/communications`).set(h(gymId)).send(b);
      expect(res.status).toBe(400);
    }
    expect((await rows(gymId, memberId)).length).toBe(0);
  });

  it('persists one trimmed alert for that member only', async () => {
    const res = await request.post(`/members/${memberId}/communications`)
      .set(h(gymId)).send({ title: '  Welcome  ', message: '  Your plan is ready.  ' });
    expect(res.status).toBe(200);
    expect(res.body.recipients).toBe(1);
    const got = await rows(gymId, memberId);
    expect(got.length).toBe(1);
    const payload = typeof got[0].payload === 'string' ? JSON.parse(got[0].payload) : got[0].payload;
    expect(payload.title).toBe('Welcome');
    expect(payload.message).toBe('Your plan is ready.');
    expect((await rows(gymId, otherMemberId)).length).toBe(0);
  });

  it('is rejected when the feature flag is off', async () => {
    await db.query(
      `INSERT INTO feature_flags (feature_key, enabled, modified_at) VALUES (?, 0, UTC_TIMESTAMP())
       ON DUPLICATE KEY UPDATE enabled = 0`, [FLAG],
    );
    invalidateFeatureFlagsCache();
    try {
      const res = await request.post(`/members/${memberId}/communications`).set(h(gymId)).send(body);
      expect(res.status).toBe(403);
    } finally {
      await db.query(`UPDATE feature_flags SET enabled = 1 WHERE feature_key = ?`, [FLAG]);
      invalidateFeatureFlagsCache();
    }
  });
});

describe('Trainer and Nutritionist (read-assigned Members roles) may send', () => {
  it.each([['trainer', () => trainerGymId], ['nutritionist', () => nutritionistGymId]])('%s', async (_n, gid) => {
    const mid = await seedMember(gid(), 'm');
    const res = await request.post(`/members/${mid}/communications`).set(h(gid())).send(body);
    expect(res.status).toBe(200);
  });
});
