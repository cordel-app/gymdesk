// #980 stage 3 — an occurrence's own Eligible Professional Services.
//
// The Activity Type names the services that may book it (#973 stage 1,
// migration 231); since migration 232 an occurrence may carry a list of its
// own, which wins while `eligible_services_override` is set and is otherwise
// the Activity Type's, exactly as a NULL `waitlist_mode` follows the activity.
// What this file pins down: the three answers of the `PUT` field (absent keeps,
// `null` re-inherits, an array — an empty one included — becomes the
// occurrence's own), that the booking gate reads the occurrence's list, that
// the change is in the audit log previous → new, and that nothing about the
// Activity Type moves (§12).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  cleanupTestGyms,
  createTestGym,
  createTestMembership,
  eventually,
  request,
  TEST_AUTH_HEADER,
} from './helpers';

let gymId: string;
let centerId: number;
let activityId: number;
let serviceA: number;
let serviceB: number;

const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

function headers(gid = gymId) {
  return { Authorization: TEST_AUTH_HEADER, 'x-gym-id': gid };
}
const put = (id: number, body: Record<string, unknown>) =>
  request.put(`/class-sessions/${id}`).set(headers()).send(body);
const get = (id: number) => request.get(`/class-sessions/${id}`).set(headers());
const book = (memberId: number, sessionId: number) =>
  request.post('/bookings').set(headers()).send({ member_id: memberId, class_session_id: sessionId });

async function createService(status: 'active' | 'inactive' = 'active'): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO professional_services (gym_id, name, is_system, system_key) VALUES (?, ?, 0, NULL)`,
    [gymId, `CSES Service ${uniq()}`],
  );
  await db.query(
    `INSERT INTO gym_professional_services (gym_id, professional_service_id, status) VALUES (?, ?, ?)`,
    [gymId, insertId, status],
  );
  return insertId;
}

async function createSession(activityTypeId = activityId): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO calendar_events
       (gym_id, center_id, title, activity_type_id, starts_at, ends_at, capacity, status)
     VALUES (?, ?, 'CSES Class', ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 48 HOUR),
             DATE_ADD(UTC_TIMESTAMP(), INTERVAL 49 HOUR), 5, 'scheduled')`,
    [gymId, centerId, activityTypeId],
  );
  return insertId;
}

async function createMember(): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO members (gym_id, name, email) VALUES (?, 'CSES Member', ?)`,
    [gymId, `cses-${uniq()}@test.com`],
  );
  await db.query(
    `INSERT INTO member_centers (gym_id, member_id, center_id, is_default, assigned_at) VALUES (?, ?, ?, 1, UTC_TIMESTAMP())`,
    [gymId, insertId, centerId],
  );
  return insertId;
}

/** Grants sessions of `serviceId` through a purchased class package. */
async function grantSessions(memberId: number, serviceId: number, sessions = 5): Promise<void> {
  const name = `CSES Package ${uniq()}`;
  const { insertId: classPackageId } = await db.query(
    `INSERT INTO class_packages (gym_id, name, number_of_sessions, price, validity_days, status)
     VALUES (?, ?, ?, 50, 180, 'active')`,
    [gymId, name, sessions],
  );
  const { insertId: productId } = await db.query(
    `INSERT INTO products
       (gym_id, name, type, units, amount, currency, billing_frequency, status, availability, is_system, class_package_id)
     VALUES (?, ?, 'sessions', ?, 50.00, 'EUR', NULL, 'active', 'available', 0, ?)`,
    [gymId, name, sessions, classPackageId],
  );
  await db.query(
    `INSERT INTO product_professional_services (gym_id, product_id, professional_service_id) VALUES (?, ?, ?)`,
    [gymId, productId, serviceId],
  );
  await db.query(
    `INSERT INTO user_class_packages (gym_id, member_id, class_package_id, purchased_at, expires_at, sessions_remaining, status)
     VALUES (?, ?, ?, UTC_TIMESTAMP(), DATE_ADD(UTC_DATE(), INTERVAL 180 DAY), ?, 'active')`,
    [gymId, memberId, classPackageId, sessions],
  );
}

async function ownRows(sessionId: number): Promise<number[]> {
  const { rows } = await db.query(
    'SELECT professional_service_id FROM calendar_event_eligible_professional_services WHERE calendar_event_id = ? ORDER BY professional_service_id',
    [sessionId],
  );
  return rows.map((r: any) => Number(r.professional_service_id));
}

async function auditRows(entityId: number) {
  const { rows } = await db.query(
    `SELECT action, previous_values, new_values FROM audit_logs
     WHERE gym_id = ? AND entity_type = 'class_session' AND entity_id = ? ORDER BY id ASC`,
    [gymId, String(entityId)],
  );
  return rows;
}
const asObject = (v: any) => (typeof v === 'string' ? JSON.parse(v) : v);

beforeAll(async () => {
  gymId = await createTestGym('CSES Gym');
  await createTestMembership(gymId, 'admin');
  const { insertId: c } = await db.query('INSERT INTO centers (gym_id, name) VALUES (?, ?)', [gymId, `CSES Center ${uniq()}`]);
  centerId = c;
  serviceA = await createService();
  serviceB = await createService();
  // A non-public activity that names service A.
  const { insertId: at } = await db.query(
    `INSERT INTO activity_types (gym_id, name, duration_minutes, max_capacity, status, public_event)
     VALUES (?, ?, 60, 10, 'active', 0)`,
    [gymId, `CSES Activity ${uniq()}`],
  );
  activityId = at;
  await db.query(
    `INSERT INTO activity_type_eligible_professional_services (gym_id, activity_type_id, professional_service_id) VALUES (?, ?, ?)`,
    [gymId, activityId, serviceA],
  );
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('reading the effective list', () => {
  it('an occurrence with no list of its own reports the Activity Type\'s, flagged inherited', async () => {
    const id = await createSession();
    const res = await get(id);
    expect(res.status).toBe(200);
    expect(res.body.eligible_services_override).toBe(false);
    expect(res.body.eligible_professional_services.map((s: any) => s.id)).toEqual([serviceA]);
    expect(res.body.eligible_professional_service_names).toHaveLength(1);
  });
});

describe('PUT /class-sessions/:id eligible_professional_service_ids', () => {
  it('an absent key keeps what the occurrence has', async () => {
    const id = await createSession();
    expect((await put(id, { max_capacity_override: 7 })).status).toBe(200);
    expect((await get(id)).body.eligible_services_override).toBe(false);
    expect(await ownRows(id)).toEqual([]);
  });

  it('an array becomes the occurrence\'s own list and wins over the Activity Type\'s', async () => {
    const id = await createSession();
    const res = await put(id, { eligible_professional_service_ids: [serviceB, serviceB] });
    expect(res.status).toBe(200);
    expect(res.body.eligible_services_override).toBe(true);
    expect(res.body.eligible_professional_services.map((s: any) => s.id)).toEqual([serviceB]);
    expect(await ownRows(id)).toEqual([serviceB]);
    // §12: the Activity Type's own list is untouched.
    const { rows } = await db.query(
      'SELECT professional_service_id FROM activity_type_eligible_professional_services WHERE activity_type_id = ?',
      [activityId],
    );
    expect(rows.map((r: any) => Number(r.professional_service_id))).toEqual([serviceA]);
  });

  it('an empty array is an own, empty list — any member may book this event', async () => {
    const id = await createSession();
    const res = await put(id, { eligible_professional_service_ids: [] });
    expect(res.status).toBe(200);
    expect(res.body.eligible_services_override).toBe(true);
    expect(res.body.eligible_professional_services).toEqual([]);
  });

  it('null follows the Activity Type again and clears the own rows', async () => {
    const id = await createSession();
    await put(id, { eligible_professional_service_ids: [serviceB] });
    const res = await put(id, { eligible_professional_service_ids: null });
    expect(res.status).toBe(200);
    expect(res.body.eligible_services_override).toBe(false);
    expect(res.body.eligible_professional_services.map((s: any) => s.id)).toEqual([serviceA]);
    expect(await ownRows(id)).toEqual([]);
  });

  it('refuses a non-array, an invalid id, another gym\'s service and a switched-off one', async () => {
    const id = await createSession();
    expect((await put(id, { eligible_professional_service_ids: 'x' })).status).toBe(400);
    expect((await put(id, { eligible_professional_service_ids: ['x'] })).status).toBe(400);
    expect((await put(id, { eligible_professional_service_ids: [999999] })).status).toBe(400);
    const inactive = await createService('inactive');
    expect((await put(id, { eligible_professional_service_ids: [inactive] })).status).toBe(400);
    const otherGym = await createTestGym('CSES Other Gym');
    const { insertId: foreign } = await db.query(
      `INSERT INTO professional_services (gym_id, name, is_system, system_key) VALUES (?, 'Foreign', 0, NULL)`, [otherGym],
    );
    expect((await put(id, { eligible_professional_service_ids: [foreign] })).status).toBe(400);
    expect(await ownRows(id)).toEqual([]);
  });

  it('keeps a service the occurrence is already subject to when the gym has since switched it off', async () => {
    const id = await createSession();
    await put(id, { eligible_professional_service_ids: [serviceB] });
    await db.query(`UPDATE gym_professional_services SET status = 'inactive' WHERE gym_id = ? AND professional_service_id = ?`, [gymId, serviceB]);
    try {
      expect((await put(id, { eligible_professional_service_ids: [serviceB] })).status).toBe(200);
    } finally {
      await db.query(`UPDATE gym_professional_services SET status = 'active' WHERE gym_id = ? AND professional_service_id = ?`, [gymId, serviceB]);
    }
  });

  it('records the change in the audit log, previous → new, by name (§11)', async () => {
    const id = await createSession();
    await put(id, { eligible_professional_service_ids: [serviceB] });
    // `recordAudit` is fire-and-forget, so the row lands a tick later.
    const rows = await eventually(() => auditRows(id), (r) => r.length >= 1);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const last = rows[rows.length - 1];
    expect(asObject(last.previous_values).eligible_professional_service_names).toHaveLength(1);
    expect(asObject(last.new_values).eligible_professional_service_names).toHaveLength(1);
    expect(asObject(last.previous_values).eligible_professional_service_names)
      .not.toEqual(asObject(last.new_values).eligible_professional_service_names);
  });
});

describe('the booking gate reads the occurrence\'s list', () => {
  it('a member with sessions for the Activity Type\'s service is refused once the occurrence names another', async () => {
    const id = await createSession();
    const memberId = await createMember();
    await grantSessions(memberId, serviceA);
    await put(id, { eligible_professional_service_ids: [serviceB] });

    const res = await book(memberId, id);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('professional_service_required');
    expect(res.body.professional_services.map((s: any) => s.id)).toEqual([serviceB]);
  });

  it('an occurrence with an own, empty list is open to a member with no sessions at all', async () => {
    const id = await createSession();
    const memberId = await createMember();
    await put(id, { eligible_professional_service_ids: [] });
    expect((await book(memberId, id)).status).toBe(201);
  });

  it('a sibling occurrence of the same activity still follows the Activity Type', async () => {
    const edited = await createSession();
    const sibling = await createSession();
    await put(edited, { eligible_professional_service_ids: [] });
    const memberId = await createMember();
    expect((await book(memberId, sibling)).status).toBe(403);
  });
});
