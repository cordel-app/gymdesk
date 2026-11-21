// #3090 stage 2 — POST /members/:memberId/personal-training-slots/book-family
// Books the same weekly slot for several members of one family through the
// existing projection and bookMemberOnSession(); each member is validated alone.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestFamily, createTestGym, createTestMembership, request } from './helpers';

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;
const SQL = 'yyyy-MM-dd HH:mm:ss';

async function member(gymId: string): Promise<number> {
  const { insertId } = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)', [gymId, 'Fam', `fam-${uniq()}@test.com`]);
  return insertId;
}

async function grantSessions(gymId: string, memberId: number, serviceId: number) {
  const name = `Pkg-${uniq()}`;
  const { insertId: cp } = await db.query(
    `INSERT INTO class_packages (gym_id, name, number_of_sessions, price, validity_days, status) VALUES (?, ?, 10, 100.00, 365, 'active')`,
    [gymId, name],
  );
  const { insertId: pid } = await db.query(
    `INSERT INTO products (gym_id, name, type, units, amount, currency, billing_frequency, status, availability, is_system, class_package_id)
     VALUES (?, ?, 'sessions', 10, 100.00, 'EUR', NULL, 'active', 'available', 0, ?)`,
    [gymId, name, cp],
  );
  await db.query('INSERT INTO product_professional_services (gym_id, product_id, professional_service_id) VALUES (?, ?, ?)', [gymId, pid, serviceId]);
  await db.query(
    `INSERT INTO user_class_packages (gym_id, member_id, class_package_id, expires_at, sessions_remaining, status) VALUES (?, ?, ?, ?, 10, 'active')`,
    [gymId, memberId, cp, DateTime.utc().plus({ days: 90 }).toFormat('yyyy-MM-dd')],
  );
}

const post = (gymId: string, memberId: number, body: unknown) =>
  request.post(`/members/${memberId}/personal-training-slots/book-family`)
    .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId).send(body as object);

describe('POST /members/:memberId/personal-training-slots/book-family', () => {
  let gymId: string;
  let a: number; let b: number; let c: number; let outsider: number;
  let slot: any;
  let serviceId: number;

  beforeAll(async () => {
    gymId = await createTestGym(`PTS Family ${uniq()}`);
    await createTestMembership(gymId, 'admin');
    await db.query('UPDATE gyms SET timezone = ? WHERE id = ?', ['UTC', gymId]);
    a = await member(gymId); b = await member(gymId); c = await member(gymId); outsider = await member(gymId);
    await createTestFamily(gymId, a, [b, c]);
    const { insertId: sid } = await db.query('INSERT INTO professional_services (gym_id, name, is_system, system_key) VALUES (?, ?, 0, NULL)', [gymId, `Svc-${uniq()}`]);
    serviceId = sid;
    await db.query(`INSERT INTO gym_professional_services (gym_id, professional_service_id, status) VALUES (?, ?, 'active')`, [gymId, sid]);
    const { insertId: at } = await db.query(`INSERT INTO activity_types (gym_id, name, max_capacity, public_event, status) VALUES (?, ?, 5, 0, 'active')`, [gymId, `Act-${uniq()}`]);
    await db.query('INSERT INTO activity_type_eligible_professional_services (gym_id, activity_type_id, professional_service_id) VALUES (?, ?, ?)', [gymId, at, sid]);
    // Only a and b hold sessions; c is in their family and shares the balance.
    await grantSessions(gymId, a, sid);
    await grantSessions(gymId, b, sid);
    const weekday = DateTime.utc().plus({ days: 3 }).weekday;
    let cursor = DateTime.utc().minus({ days: 10 }).startOf('day');
    cursor = cursor.plus({ days: (weekday - cursor.weekday + 7) % 7 });
    const end = DateTime.utc().plus({ months: 2, days: 10 });
    for (; cursor < end; cursor = cursor.plus({ weeks: 1 })) {
      const start = cursor.set({ hour: 10, minute: 0 });
      await db.query(
        `INSERT INTO calendar_events (gym_id, title, activity_type_id, professional_service_id, capacity, starts_at, ends_at, status)
         VALUES (?, ?, ?, ?, NULL, ?, ?, 'scheduled')`,
        [gymId, `Occ ${uniq()}`, at, sid, start.toFormat(SQL), start.plus({ hours: 1 }).toFormat(SQL)],
      );
    }
    const res = await request.get(`/members/${a}/personal-training-slots`).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
    slot = res.body.days.find((d: any) => d.weekday === weekday).slots[0];
  });

  const identity = () => ({
    weekday: slot.weekday, start_time: slot.start_time, end_time: slot.end_time,
    activity_type_id: slot.activity_type_id, professional_service_id: slot.professional_service_id,
    center_id: slot.center_id ?? null,
  });

  it('books every family member through the shared family balance', async () => {
    const res = await post(gymId, a, { member_ids: [a, b, c], slots: [identity()] });
    expect(res.status).toBe(200);
    const byId = new Map<number, any>(res.body.members.map((m: any) => [m.member_id, m]));
    expect(byId.get(a).created).toBeGreaterThan(0);
    expect(byId.get(b).created).toBeGreaterThan(0);
    expect(byId.get(c).created).toBeGreaterThan(0); // the Professional Services balance is the family's (#2670)
    const { rows } = await db.query('SELECT DISTINCT member_id FROM calendar_event_bookings WHERE gym_id = ? AND status = ?', [gymId, 'booked']);
    expect(rows.map((r: any) => r.member_id).sort()).toEqual([a, b, c].sort());
  });

  it('is idempotent: a second call creates nothing new', async () => {
    const res = await post(gymId, a, { member_ids: [a, b], slots: [identity()] });
    expect(res.status).toBe(200);
    expect(res.body.created).toBe(0);
  });

  it('refuses a member outside the family', async () => {
    const res = await post(gymId, a, { member_ids: [a, outsider], slots: [identity()] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('member_not_in_family');
  });

  it('validates the body', async () => {
    expect((await post(gymId, a, { member_ids: [], slots: [identity()] })).status).toBe(400);
    expect((await post(gymId, a, { member_ids: [a], slots: [] })).status).toBe(400);
  });

  it('is tenant isolated and requires auth', async () => {
    const other = await createTestGym(`PTS Other ${uniq()}`);
    await createTestMembership(other, 'admin');
    const res = await post(other, a, { member_ids: [a], slots: [identity()] });
    expect(res.status).toBe(404);
    const anon = await request.post(`/members/${a}/personal-training-slots/book-family`).set('x-gym-id', gymId).send({});
    expect(anon.status).toBe(401);
  });
});
