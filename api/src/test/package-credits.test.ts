// Tests for #372: attendance/cancellation-driven package-credit consumption,
// manual same-day refund, walk-in (no-booking) attendance, and package
// expiration extension.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { verifyToken } from '@clerk/backend';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER,
  TEST_USER_ID,
  cleanupTestGyms,
  createTestGym,
  createTestMembership,
  request,
} from './helpers';

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

async function createCenter(gymId: string): Promise<number> {
  const { insertId } = await db.query(`INSERT INTO centers (gym_id, name) VALUES (?, ?)`, [gymId, `Center-${Date.now()}`]);
  return insertId;
}

async function createActivityType(gymId: string, maxCapacity = 5): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO activity_types (gym_id, name, max_capacity, status) VALUES (?, 'PT Test', ?, 'active')`,
    [gymId, maxCapacity],
  );
  // class_sessions.class_type_id may still legacy-FK into class_types on older DB states — mirror the row.
  await db.query(
    `INSERT IGNORE INTO class_types (id, gym_id, name, max_capacity, status) VALUES (?, ?, 'PT Test', ?, 'active')`,
    [insertId, gymId, maxCapacity],
  ).catch(() => {});
  return insertId;
}

async function createSessionStarting(gymId: string, activityTypeId: number, centerId: number, intervalSql: string): Promise<number> {
  // class_type_id is a legacy NOT NULL column present in older DB states (pre-059 drop) — see bookings.test.ts.
  try {
    const { insertId } = await db.query(
      `INSERT INTO class_sessions (gym_id, activity_type_id, class_type_id, center_id, starts_at, ends_at, status)
       VALUES (?, ?, ?, ?, ${intervalSql}, DATE_ADD(${intervalSql}, INTERVAL 1 HOUR), 'scheduled')`,
      [gymId, activityTypeId, activityTypeId, centerId],
    );
    return insertId;
  } catch (err: any) {
    if (err.code !== 'ER_BAD_FIELD_ERROR') throw err;
    const { insertId } = await db.query(
      `INSERT INTO class_sessions (gym_id, activity_type_id, center_id, starts_at, ends_at, status)
       VALUES (?, ?, ?, ${intervalSql}, DATE_ADD(${intervalSql}, INTERVAL 1 HOUR), 'scheduled')`,
      [gymId, activityTypeId, centerId],
    );
    return insertId;
  }
}

async function createMember(gymId: string, centerId: number): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO members (gym_id, name, email) VALUES (?, 'Package Test Member', ?)`,
    [gymId, `pkg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.com`],
  );
  await db.query(
    `INSERT INTO member_centers (gym_id, member_id, center_id, is_default, assigned_at) VALUES (?, ?, ?, 1, UTC_TIMESTAMP())`,
    [gymId, insertId, centerId],
  );
  return insertId;
}

async function createMembershipPlan(gymId: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status) VALUES (?, ?, 'active', 'staff_only')`,
    [gymId, `Plan-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`],
  );
  return insertId;
}

/** Makes activityTypeId "plan-restricted" so the package-credit hook kicks in for members without a matching plan. */
async function restrictActivityType(gymId: string, membershipPlanId: number, activityTypeId: number) {
  await db.query(
    `INSERT INTO plan_allowances (gym_id, membership_plan_id, activity_type_id, allowance_type) VALUES (?, ?, ?, 'unlimited')`,
    [gymId, membershipPlanId, activityTypeId],
  );
}

async function createClassPackage(gymId: string, sessions = 10): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO class_packages (gym_id, name, number_of_sessions, price, validity_days, status)
     VALUES (?, ?, ?, 50, 180, 'active')`,
    [gymId, `Package-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, sessions],
  );
  return insertId;
}

async function assignPackage(gymId: string, memberId: number, classPackageId: number, sessionsRemaining: number): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO user_class_packages (gym_id, member_id, class_package_id, purchased_at, expires_at, sessions_remaining, status)
     VALUES (?, ?, ?, UTC_TIMESTAMP(), DATE_ADD(UTC_DATE(), INTERVAL 180 DAY), ?, 'active')`,
    [gymId, memberId, classPackageId, sessionsRemaining],
  );
  return insertId;
}

async function getPackage(id: number) {
  const { rows } = await db.query('SELECT * FROM user_class_packages WHERE id = ?', [id]);
  return rows[0];
}

describe('Package-credit consumption (#372)', () => {
  let gymId: string;
  let centerId: number;
  let activityTypeId: number;
  let classPackageId: number;

  beforeAll(async () => {
    gymId = await createTestGym('Package Credits Gym');
    await createTestMembership(gymId, 'admin');
    centerId = await createCenter(gymId);
    activityTypeId = await createActivityType(gymId);
    const planId = await createMembershipPlan(gymId);
    await restrictActivityType(gymId, planId, activityTypeId);
    classPackageId = await createClassPackage(gymId);
  });

  it('debits a credit on booking and auto-refunds it when cancelled >= 1 day before the session', async () => {
    const memberId = await createMember(gymId, centerId);
    const packageId = await assignPackage(gymId, memberId, classPackageId, 5);
    const sessionId = await createSessionStarting(gymId, activityTypeId, centerId, 'DATE_ADD(UTC_TIMESTAMP(), INTERVAL 2 DAY)');

    const bookRes = await request
      .post('/bookings')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_id: memberId, class_session_id: sessionId });
    expect(bookRes.status).toBe(201);

    expect(Number((await getPackage(packageId)).sessions_remaining)).toBe(4);

    const cancelRes = await request
      .delete(`/bookings/${bookRes.body.id}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(cancelRes.status).toBe(204);

    expect(Number((await getPackage(packageId)).sessions_remaining)).toBe(5);
  });

  it('keeps the credit consumed on a same-day cancellation, and lets a trainer manually refund it once', async () => {
    const memberId = await createMember(gymId, centerId);
    const packageId = await assignPackage(gymId, memberId, classPackageId, 5);
    const sessionId = await createSessionStarting(gymId, activityTypeId, centerId, 'DATE_ADD(UTC_TIMESTAMP(), INTERVAL 2 HOUR)');

    const bookRes = await request
      .post('/bookings')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_id: memberId, class_session_id: sessionId });
    expect(bookRes.status).toBe(201);
    expect(Number((await getPackage(packageId)).sessions_remaining)).toBe(4);

    const cancelRes = await request
      .delete(`/bookings/${bookRes.body.id}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(cancelRes.status).toBe(204);

    // Same-day cancellation: credit stays consumed, no auto-refund.
    expect(Number((await getPackage(packageId)).sessions_remaining)).toBe(4);

    const refundRes = await request
      .post(`/bookings/${bookRes.body.id}/refund-credit`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(refundRes.status).toBe(200);
    expect(Number((await getPackage(packageId)).sessions_remaining)).toBe(5);

    // A second manual refund on the same booking must not double-refund.
    const secondRefundRes = await request
      .post(`/bookings/${bookRes.body.id}/refund-credit`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(secondRefundRes.status).toBe(400);
    expect(Number((await getPackage(packageId)).sessions_remaining)).toBe(5);
  });

  it('rejects a manual refund with the wrong role', async () => {
    const nutritionistUserId = `nutritionist-${Date.now()}`;
    await createTestMembership(gymId, 'nutritionist', nutritionistUserId);

    const memberId = await createMember(gymId, centerId);
    const packageId = await assignPackage(gymId, memberId, classPackageId, 5);
    const sessionId = await createSessionStarting(gymId, activityTypeId, centerId, 'DATE_ADD(UTC_TIMESTAMP(), INTERVAL 1 HOUR)');
    const bookRes = await request
      .post('/bookings')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_id: memberId, class_session_id: sessionId });
    await request.delete(`/bookings/${bookRes.body.id}`).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);

    // Only mock the identity for this one request — the setup calls above must stay admin.
    vi.mocked(verifyToken).mockResolvedValueOnce({ sub: nutritionistUserId } as any);
    const res = await request
      .post(`/bookings/${bookRes.body.id}/refund-credit`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(403);
    expect(Number((await getPackage(packageId)).sessions_remaining)).toBe(4);
  });

  it('walk-in attendance (no prior booking) consumes a credit', async () => {
    const memberId = await createMember(gymId, centerId);
    const packageId = await assignPackage(gymId, memberId, classPackageId, 5);
    const sessionId = await createSessionStarting(gymId, activityTypeId, centerId, 'UTC_TIMESTAMP()');

    const res = await request
      .post(`/class-sessions/${sessionId}/walk-in`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_id: memberId });
    expect(res.status).toBe(201);

    const { rows } = await db.query('SELECT status, attendance_status, user_class_package_id FROM bookings WHERE id = ?', [res.body.booking_id]);
    expect(rows[0].status).toBe('booked');
    expect(rows[0].attendance_status).toBe('present');
    expect(rows[0].user_class_package_id).toBe(packageId);
    expect(Number((await getPackage(packageId)).sessions_remaining)).toBe(4);

    // A member who already has an active booking can't be walked in again.
    const dupRes = await request
      .post(`/class-sessions/${sessionId}/walk-in`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_id: memberId });
    expect(dupRes.status).toBe(409);
  });
});

describe('Package expiration extension (#372)', () => {
  let gymId: string;
  let otherGymId: string;
  let centerId: number;
  let classPackageId: number;
  let memberId: number;
  let packageId: number;

  beforeAll(async () => {
    gymId = await createTestGym('Package Expiration Gym');
    otherGymId = await createTestGym('Package Expiration Other Gym');
    await createTestMembership(gymId, 'admin');
    await createTestMembership(otherGymId, 'admin', `${TEST_USER_ID}-other`);
    centerId = await createCenter(gymId);
    classPackageId = await createClassPackage(gymId);
    memberId = await createMember(gymId, centerId);
    packageId = await assignPackage(gymId, memberId, classPackageId, 3);
  });

  it('rejects a new expiration date that is not later than the current one', async () => {
    const current = await getPackage(packageId);
    const sameDate = new Date(current.expires_at).toISOString().slice(0, 10);
    const res = await request
      .put(`/members/${memberId}/class-packages/${packageId}/extend-expiration`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ expires_at: sameDate });
    expect(res.status).toBe(400);
  });

  it('extends the expiration date for authorized staff', async () => {
    const current = await getPackage(packageId);
    const newDate = new Date(current.expires_at);
    newDate.setDate(newDate.getDate() + 30);
    const newDateStr = newDate.toISOString().slice(0, 10);

    const res = await request
      .put(`/members/${memberId}/class-packages/${packageId}/extend-expiration`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ expires_at: newDateStr });
    expect(res.status).toBe(200);
    expect(new Date(res.body.expires_at).toISOString().slice(0, 10)).toBe(newDateStr);
  });

  it('returns 404 for a package belonging to a different gym', async () => {
    // This path is matched by both the broad `/members` mount and the nested
    // `/members/:memberId/class-packages` mount, so requireAuth() (and verifyToken)
    // runs twice per request — queue the override identity for both calls.
    vi.mocked(verifyToken).mockResolvedValueOnce({ sub: `${TEST_USER_ID}-other` } as any);
    vi.mocked(verifyToken).mockResolvedValueOnce({ sub: `${TEST_USER_ID}-other` } as any);
    const res = await request
      .put(`/members/${memberId}/class-packages/${packageId}/extend-expiration`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', otherGymId)
      .send({ expires_at: '2099-01-01' });
    expect(res.status).toBe(404);
  });
});
