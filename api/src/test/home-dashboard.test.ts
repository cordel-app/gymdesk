// Integration tests for the Home dashboard (#1367) and the Welcomed route.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { dayWindow, todayInZone, resolveTimeZone, completedWeekWindows } from '../domain/homeDashboard';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, ensureTestProductSet, request } from './helpers';

let gymA: string;
let gymB: string;
let memberA: number;

const get = (gym: string, path = '/dashboard/home') =>
  request.get(path).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gym);

beforeAll(async () => {
  gymA = await createTestGym('Home A');
  gymB = await createTestGym('Home B');
  await createTestMembership(gymA, 'admin');
  await createTestMembership(gymB, 'admin');
  const u = `${Date.now()}`;
  const email = `home-${u}@example.com`;
  await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)', [gymA, 'Home Member', email]);
  memberA = Number((await db.query('SELECT id FROM members WHERE gym_id = ? AND email = ?', [gymA, email])).rows[0].id);
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('GET /dashboard/home', () => {
  it('requires authentication', async () => {
    expect((await request.get('/dashboard/home').set('x-gym-id', gymA)).status).toBe(401);
  });

  it('returns the cards, tasks and panels for an admin', async () => {
    const res = await get(gymA);
    expect(res.status).toBe(200);
    expect(res.body.access).toEqual({ members: true, classes: true, payments: true });
    expect(res.body.cards.active_members).toBeDefined();
    expect(res.body.cards.classes_today.count).toBe(0);
    expect(Array.isArray(res.body.classes)).toBe(true);
    expect(res.body.latest_members.map((m: any) => m.name)).toContain('Home Member');
  });

  it('is always today: a date query is ignored (#1754)', async () => {
    const res = await get(gymA, '/dashboard/home?date=2001-01-01');
    expect(res.status).toBe(200);
    expect(res.body.date).toBe(res.body.today);
  });

  it('never leaks another gym\'s members', async () => {
    const res = await get(gymB);
    expect(res.status).toBe(200);
    expect(res.body.latest_members.map((m: any) => m.name)).not.toContain('Home Member');
  });
});

describe('classes_today card (#1510)', () => {
  it('counts classes with a booked member against all classes of the day', async () => {
    const zone = resolveTimeZone((await db.query('SELECT time_zone FROM gyms WHERE id = ?', [gymB])).rows[0]?.time_zone);
    const dayStart = dayWindow(todayInZone(zone), zone).from;
    const at = await db.query(`INSERT INTO activity_types (gym_id, name, max_capacity, status) VALUES (?, 'Spin', 10, 'active')`, [gymB]);
    const m = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)', [gymB, 'Booker', `bk-${Date.now()}@example.com`]);
    const ids: number[] = [];
    for (const hour of [1, 3, 5]) {
      const r = await db.query(
        `INSERT INTO calendar_events (gym_id, title, activity_type_id, starts_at, ends_at, status)
         VALUES (?, 'Spin', ?, DATE_ADD(?, INTERVAL ? HOUR), DATE_ADD(?, INTERVAL ? MINUTE), 'scheduled')`,
        [gymB, at.insertId, dayStart, hour, dayStart, hour * 60 + 45],
      );
      ids.push(r.insertId);
    }
    await db.query(
      `INSERT INTO calendar_event_bookings (gym_id, calendar_event_id, member_id, status) VALUES (?, ?, ?, 'booked')`,
      [gymB, ids[0], m.insertId],
    );
    const res = await get(gymB);
    expect(res.status).toBe(200);
    expect(res.body.cards.classes_today.count).toBe(1);
    expect(res.body.cards.classes_today.total).toBe(3);
  });
});

describe('PUT /members/:id/welcomed', () => {
  it('ticks and unticks, and the task follows welcomed_at IS NULL', async () => {
    await db.query('UPDATE members SET welcomed_at = NULL WHERE id = ?', [memberA]);
    let home = await get(gymA);
    expect(home.body.tasks.find((t: any) => t.key === 'welcome_new_members')?.count).toBe(1);

    const on = await request.put(`/members/${memberA}/welcomed`).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymA).send({ welcomed: true });
    expect(on.status).toBe(200);
    expect(on.body.welcomed_at).toBeTruthy();
    home = await get(gymA);
    expect(home.body.tasks.find((t: any) => t.key === 'welcome_new_members')).toBeUndefined();

    const off = await request.put(`/members/${memberA}/welcomed`).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymA).send({ welcomed: false });
    expect(off.body.welcomed_at).toBeNull();
    const list = await request.get('/members?welcomed=false').set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymA);
    expect(list.body.map((m: any) => m.id)).toContain(memberA);
  });

  it('is tenant-scoped and validates the body', async () => {
    const other = await request.put(`/members/${memberA}/welcomed`).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymB).send({ welcomed: true });
    expect(other.status).toBe(404);
    const bad = await request.put(`/members/${memberA}/welcomed`).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymA).send({ welcomed: 'yes' });
    expect(bad.status).toBe(400);
  });
});

describe('GET /dashboard/home — pending payment members (#1466)', () => {
  it('lists a member once with summed amount, ignores resolved events, and is tenant-scoped', async () => {
    const gym = await createTestGym('Home Pending');
    await createTestMembership(gym, 'admin');
    const email = `pending-${Date.now()}@example.com`;
    const { insertId: memberId } = await db.query(
      'INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)', [gym, 'Pending Member', email],
    );
    const setId = await ensureTestProductSet(gym, Number(memberId));
    for (const [type, amount] of [['failed_billing', '30.00'], ['failed_billing', '12.50'], ['waived_billing', '99.00']]) {
      await db.query(
        `INSERT INTO billing_events (gym_id, product_set_id, member_id, event_type, amount, source, billing_date)
         VALUES (?, ?, ?, ?, ?, 'system', UTC_DATE())`,
        [gym, setId, memberId, type, amount],
      );
    }
    const res = await get(gym);
    expect(res.status).toBe(200);
    const section = res.body.pending_payment_members;
    expect(section.count).toBe(1);
    expect(section.members).toHaveLength(1);
    expect(section.members[0]).toMatchObject({ member_id: Number(memberId), name: 'Pending Member', outstanding_amount: 42.5 });

    // Another gym never sees it.
    const other = await get(gymB);
    expect(other.body.pending_payment_members.count).toBe(0);
  });

  it('is absent for a role that cannot read payments', async () => {
    const gym = await createTestGym('Home Pending Role');
    await createTestMembership(gym, 'trainer_performance');
    const res = await get(gym);
    expect(res.status).toBe(200);
    expect(res.body.pending_payment_members).toBeUndefined();
  });
});

describe('attendance KPIs (#1754)', () => {
  it('counts only members with an attended session in each of the last four complete weeks', async () => {
    const gym = await createTestGym('Home KPI');
    await createTestMembership(gym, 'admin');
    const zone = resolveTimeZone((await db.query('SELECT time_zone FROM gyms WHERE id = ?', [gym])).rows[0]?.time_zone);
    const weeks = completedWeekWindows(todayInZone(zone), zone);
    const at = await db.query(`INSERT INTO activity_types (gym_id, name, max_capacity, status) VALUES (?, 'Yoga', 10, 'active')`, [gym]);
    const mk = async (name: string) => {
      const m = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)', [gym, name, `${name}-${Date.now()}@example.com`]);
      const ums = await db.query(
        `INSERT INTO user_memberships (gym_id, member_id, status, starts_at) VALUES (?, ?, 'active', '2020-01-01')`,
        [gym, m.insertId],
      );
      await ensureTestProductSet(gym, m.insertId, ums.insertId);
      return m.insertId as number;
    };
    const attend = async (memberId: number, weekIdx: number, attendance: string, bookingStatus = 'booked') => {
      const ev = await db.query(
        `INSERT INTO calendar_events (gym_id, title, activity_type_id, starts_at, ends_at, status)
         VALUES (?, 'Yoga', ?, DATE_ADD(?, INTERVAL 10 HOUR), DATE_ADD(?, INTERVAL 11 HOUR), 'scheduled')`,
        [gym, at.insertId, weeks[weekIdx].from, weeks[weekIdx].from],
      );
      await db.query(
        `INSERT INTO calendar_event_bookings (gym_id, calendar_event_id, member_id, status, attendance_status) VALUES (?, ?, ?, ?, ?)`,
        [gym, ev.insertId, memberId, bookingStatus, attendance],
      );
    };
    const full = await mk('Full');
    const missing = await mk('Missing');
    const absent = await mk('Absent');
    for (let w = 0; w < 4; w++) await attend(full, w, 'present');
    for (const w of [0, 1, 2]) await attend(missing, w, 'present');
    await attend(missing, 3, 'absent');
    for (let w = 0; w < 4; w++) await attend(absent, w, 'present', 'cancelled');

    const res = await get(gym);
    expect(res.status).toBe(200);
    expect(res.body.cards.attendance.top_trainers).toBe(1);
    // 4 + 3 attended sessions, over the gym's active members and 4 weeks.
    const active = res.body.cards.active_members.count;
    expect(res.body.cards.attendance.average_classes_per_member_per_week).toBeCloseTo(Math.round((7 / active / 4) * 100) / 100, 2);
  });
});

describe('GET /dashboard/home — incomplete classes (#1984 stage 3)', () => {
  it('lists a service with some but not all places, hides full ones, and is tenant-scoped', async () => {
    const u = `${Date.now()}`;
    const { insertId: center } = await db.query('INSERT INTO centers (gym_id, name) VALUES (?, ?)', [gymA, `IC-${u}`]);
    const { insertId: at } = await db.query(
      `INSERT INTO activity_types (gym_id, name, max_capacity, status) VALUES (?, 'Incomplete Act', 10, 'active')`, [gymA]);
    const mkSvc = async (name: string, cap: number) => {
      const { insertId } = await db.query(
        'INSERT INTO professional_services (gym_id, name, is_system, system_key) VALUES (?, ?, 0, NULL)', [gymA, `${name} ${u}`]);
      await db.query(
        `INSERT INTO activity_type_eligible_professional_services (gym_id, activity_type_id, professional_service_id, capacity) VALUES (?, ?, ?, ?)`,
        [gymA, at, insertId, cap]);
      return insertId;
    };
    const duo = await mkSvc('Duo', 2);
    const solo = await mkSvc('Solo', 1);
    const { insertId: ev } = await db.query(
      `INSERT INTO calendar_events (gym_id, center_id, title, activity_type_id, starts_at, ends_at, capacity, status)
       VALUES (?, ?, 'IC', ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 30 HOUR), DATE_ADD(UTC_TIMESTAMP(), INTERVAL 31 HOUR), 10, 'scheduled')`,
      [gymA, center, at]);
    const book = (svc: number) => db.query(
      `INSERT INTO calendar_event_bookings (gym_id, calendar_event_id, member_id, status, professional_service_id) VALUES (?, ?, ?, 'booked', ?)`,
      [gymA, ev, memberA, svc]);
    await book(duo);
    const res = await get(gymA);
    const mine = res.body.incomplete_classes.items.filter((i: any) => i.event_id === ev);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ service_id: duo, occupied: 1, capacity: 2, remaining: 1, participants: ['Home Member'] });

    await db.query('UPDATE calendar_event_bookings SET professional_service_id = ? WHERE calendar_event_id = ?', [solo, ev]);
    const res2 = await get(gymA);
    expect(res2.body.incomplete_classes.items.filter((i: any) => i.event_id === ev)).toHaveLength(0);

    const other = await get(gymB);
    expect(other.body.incomplete_classes.items.filter((i: any) => i.event_id === ev)).toHaveLength(0);
  });
});
