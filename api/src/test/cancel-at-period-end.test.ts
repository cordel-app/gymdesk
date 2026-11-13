// #2659 stage 2: a cancellation writes `active_cancel_at_period_end` while the
// plan still runs (its last paid day is today or later), the plan keeps its
// access until `ends_at`, and the end-of-period sweep moves it to `cancelled`.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER, cleanupTestGyms, createTestDraftAssignment,
  createTestGym, createTestMembership, request,
} from './helpers';
import { CANCELS_AT_PERIOD_END_STATUS, cancellationStatusFor } from '../domain/assignmentStatus';

const SECRET = 'test-billing-secret-2659';
let gymId: string;
let centerA: number;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;

async function member(): Promise<number> {
  const { insertId } = await db.query(
    'INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, 'Period End Member', `pe-${uniq()}@test.com`],
  );
  return insertId as number;
}
async function plan(): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit, center_access_mode)
     VALUES (?, ?, 'active', 'public', 1, 'specific_centers')`,
    [gymId, `PE Plan ${uniq()}`],
  );
  await db.query('INSERT INTO membership_plan_centers (gym_id, membership_plan_id, center_id) VALUES (?, ?, ?)', [gymId, insertId, centerA]);
  await db.query(`INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
                  VALUES (?, ?, 10, '2020-01-01', 'active')`, [gymId, insertId]);
  await db.query(`INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
                  VALUES (?, ?, 1, 'month')`, [gymId, insertId]);
  return insertId as number;
}
async function assign(memberId: number): Promise<number> {
  const um = await createTestDraftAssignment(gymId, memberId, await plan());
  const res = await request.post(`/user-memberships/${um}/activate`)
    .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId).send({ on_conflict: 'add' });
  if (res.status >= 300) throw new Error(`activate: ${res.status} ${JSON.stringify(res.body)}`);
  return um;
}
const cancel = (umId: number) =>
  request.delete(`/user-memberships/${umId}`).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
const centers = async (memberId: number) =>
  (await request.get(`/members/${memberId}/centers/effective-access`)
    .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId)).body.specific_centers as unknown[];
async function stored(umId: number) {
  const { rows } = await db.query<{ status: string; ends_at: string; today: string }>(
    `SELECT status, DATE_FORMAT(ends_at, '%Y-%m-%d') AS ends_at, DATE_FORMAT(UTC_DATE(), '%Y-%m-%d') AS today
       FROM user_memberships WHERE id = ?`, [umId]);
  return rows[0];
}
const sweep = (secret = SECRET) => request.post('/assignment-lifecycle/run').set('X-Internal-Secret', secret);

beforeAll(async () => {
  process.env.BILLING_INTERNAL_SECRET = SECRET;
  gymId = await createTestGym('Cancel At Period End Gym');
  await createTestMembership(gymId, 'admin');
  const { insertId } = await db.query('INSERT INTO centers (gym_id, name, status) VALUES (?, ?, ?)', [gymId, 'PE Center', 'active']);
  centerA = insertId as number;
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('cancellationStatusFor()', () => {
  it('keeps a plan whose last paid day is today or later running, ends one with nothing left', () => {
    expect(cancellationStatusFor('2026-05-10', '2026-05-10')).toBe(CANCELS_AT_PERIOD_END_STATUS);
    expect(cancellationStatusFor('2026-06-01', '2026-05-10')).toBe(CANCELS_AT_PERIOD_END_STATUS);
    expect(cancellationStatusFor('2026-05-09', '2026-05-10')).toBe('cancelled');
    expect(cancellationStatusFor(null, '2026-05-10')).toBe('cancelled');
  });
});

describe('cancelling a projected plan', () => {
  it('writes active_cancel_at_period_end while the plan still runs, and audits that transition', async () => {
    const m = await member();
    const um = await assign(m); // starts today: access runs through today
    expect((await cancel(um)).status).toBe(204);
    const row = await stored(um);
    expect(row.status).toBe(CANCELS_AT_PERIOD_END_STATUS);
    expect(row.ends_at).toBe(row.today);
    const { rows: audit } = await db.query<{ new_values: any }>(
      `SELECT new_values FROM audit_logs WHERE gym_id = ? AND entity_type = 'user_membership' AND entity_id = ?
          AND action = 'status_change' ORDER BY id DESC LIMIT 1`, [gymId, String(um)]);
    const next = typeof audit[0].new_values === 'string' ? JSON.parse(audit[0].new_values) : audit[0].new_values;
    expect(next.status).toBe(CANCELS_AT_PERIOD_END_STATUS);
    // Cannot be cancelled twice.
    expect((await cancel(um)).status).toBe(404);
  });

  it('writes cancelled when nothing is left to run', async () => {
    const m = await member();
    const um = await assign(m);
    await db.query('UPDATE user_memberships SET starts_at = CURDATE() - INTERVAL 30 DAY WHERE id = ?', [um]);
    expect((await cancel(um)).status).toBe(204);
    expect((await stored(um)).status).toBe('cancelled');
  });
});

describe('access until ends_at', () => {
  it('a plan cancelling at its period end keeps its centers until ends_at, then not', async () => {
    const m = await member();
    const um = await assign(m);
    expect(await centers(m)).toHaveLength(1);
    // Cancelled through the route: the plan runs to its last paid day (today).
    expect((await cancel(um)).status).toBe(204);
    expect((await stored(um)).status).toBe(CANCELS_AT_PERIOD_END_STATUS);
    expect(await centers(m)).toHaveLength(1);
    // Past its end date but before the sweep has run: no access. #2125 M6b-3: the access readers
    // ask the assignment's plan snapshot, so the date is moved there as well as on the legacy row.
    await db.query('UPDATE user_memberships SET ends_at = UTC_DATE() - INTERVAL 1 DAY WHERE id = ?', [um]);
    await db.query('UPDATE plan_snapshots SET ends_at = UTC_DATE() - INTERVAL 1 DAY WHERE source_user_membership_id = ?', [um]);
    expect(await centers(m)).toEqual([]);
  });
});

describe('POST /assignment-lifecycle/run', () => {
  it('refuses a wrong secret', async () => {
    expect((await sweep('wrong')).status).toBe(401);
  });

  it('moves only plans past their end date to cancelled, audits each, and is idempotent', async () => {
    const m = await member();
    const due = await assign(m);
    const running = await assign(m);
    await db.query(
      `UPDATE user_memberships SET status = ?, ends_at = UTC_DATE() - INTERVAL 1 DAY WHERE id = ?`,
      [CANCELS_AT_PERIOD_END_STATUS, due]);
    await db.query(
      `UPDATE user_memberships SET status = ?, ends_at = UTC_DATE() WHERE id = ?`,
      [CANCELS_AT_PERIOD_END_STATUS, running]);

    const first = await sweep();
    expect(first.status).toBe(200);
    expect(first.body.cancelled).toBeGreaterThanOrEqual(1);
    expect((await stored(due)).status).toBe('cancelled');
    expect((await stored(running)).status).toBe(CANCELS_AT_PERIOD_END_STATUS);

    const { rows: audit } = await db.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM audit_logs WHERE gym_id = ? AND entity_type = 'user_membership' AND entity_id = ?
          AND action = 'status_change' AND JSON_EXTRACT(new_values, '$.status') = 'cancelled'`, [gymId, String(due)]);
    expect(Number(audit[0].n)).toBe(1);

    const second = await sweep();
    expect(second.status).toBe(200);
    expect((await stored(due)).status).toBe('cancelled');
    const { rows: again } = await db.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM audit_logs WHERE gym_id = ? AND entity_type = 'user_membership' AND entity_id = ?
          AND action = 'status_change' AND JSON_EXTRACT(new_values, '$.status') = 'cancelled'`, [gymId, String(due)]);
    expect(Number(again[0].n)).toBe(1);
  });
});
