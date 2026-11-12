// #2720 — /members/:memberId/bookings: the Admin Member card's Bookings tab.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { cleanupTestGyms, createTestGym, createTestMembership, request, TEST_AUTH_HEADER } from './helpers';

let gymId: string;
let otherGymId: string;
let memberId: number;
let otherMemberId: number;
let activityId: number;
const ids: Record<string, number> = {};

const staff = (req: any, gid = gymId) => req.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gid);

async function member(gid: string, name: string): Promise<number> {
  const { insertId } = await db.query(
    'INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gid, name, `mb-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.com`],
  );
  return insertId;
}
async function event(startsAt: string, status = 'scheduled'): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO calendar_events (gym_id, title, activity_type_id, capacity, starts_at, ends_at, status)
     VALUES (?, 'Morning Yoga', ?, 10, ?, DATE_ADD(?, INTERVAL 1 HOUR), ?)`,
    [gymId, activityId, startsAt, startsAt, status],
  );
  return insertId;
}
async function book(ev: number, m: number, status: 'booked' | 'waitlisted' | 'cancelled'): Promise<number> {
  const { insertId } = await db.query(
    'INSERT INTO calendar_event_bookings (gym_id, calendar_event_id, member_id, status) VALUES (?, ?, ?, ?)',
    [gymId, ev, m, status],
  );
  return insertId;
}

beforeAll(async () => {
  gymId = await createTestGym('Member Bookings Gym');
  otherGymId = await createTestGym('Member Bookings Other Gym');
  await createTestMembership(gymId, 'admin');
  await createTestMembership(otherGymId, 'admin');
  memberId = await member(gymId, 'Booking Member');
  otherMemberId = await member(gymId, 'Other Booking Member');
  activityId = (await db.query(
    `INSERT INTO activity_types (gym_id, name, duration_minutes, max_capacity, status) VALUES (?, 'Yoga', 60, 10, 'active')`,
    [gymId],
  )).insertId;

  ids.farFuture = await book(await event('2099-03-01 10:00:00'), memberId, 'booked');
  ids.nearFuture = await book(await event('2099-01-01 10:00:00'), memberId, 'waitlisted');
  ids.futureCancelled = await book(await event('2099-02-01 10:00:00'), memberId, 'cancelled');
  ids.eventCancelled = await book(await event('2099-04-01 10:00:00', 'cancelled'), memberId, 'booked');
  ids.oldPast = await book(await event('2020-01-01 10:00:00'), memberId, 'booked');
  ids.recentPast = await book(await event('2021-01-01 10:00:00', 'completed'), memberId, 'booked');
  ids.otherMember = await book(await event('2099-01-15 10:00:00'), otherMemberId, 'booked');
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('GET /members/:memberId/bookings (#2720)', () => {
  it('rejects an unauthenticated request', async () => {
    await request.get(`/members/${memberId}/bookings`).set('x-gym-id', gymId).expect(401);
  });

  it('does not reveal a member of another gym', async () => {
    await staff(request.get(`/members/${memberId}/bookings`), otherGymId).expect(404);
  });

  it('splits upcoming (nearest first) from past (most recent first), each booking once', async () => {
    const res = await staff(request.get(`/members/${memberId}/bookings`)).expect(200);
    expect(res.body.upcoming.map((b: any) => b.id)).toEqual([ids.nearFuture, ids.farFuture]);
    // Past: ended events by most recent start, plus bookings no longer live
    // (cancelled booking, cancelled event), all ordered by start descending.
    expect(res.body.past.map((b: any) => b.id)).toEqual([
      ids.eventCancelled, ids.futureCancelled, ids.recentPast, ids.oldPast,
    ]);
    const all = [...res.body.upcoming, ...res.body.past].map((b: any) => b.id);
    expect(new Set(all).size).toBe(all.length);
    expect(all).not.toContain(ids.otherMember);
  });

  it('reports the event and booking details', async () => {
    const res = await staff(request.get(`/members/${memberId}/bookings`)).expect(200);
    const near = res.body.upcoming[0];
    expect(near).toMatchObject({ status: 'waitlisted', event_name: 'Morning Yoga', session_status: 'scheduled' });
    expect(near.starts_at).toBeTruthy();
    expect(near.ends_at).toBeTruthy();
    expect(near).not.toHaveProperty('has_ended');
    expect(res.body.past.find((b: any) => b.id === ids.recentPast).session_status).toBe('completed');
  });

  it('answers empty lists for a member with no bookings', async () => {
    const lonely = await member(gymId, 'No Bookings');
    const res = await staff(request.get(`/members/${lonely}/bookings`)).expect(200);
    expect(res.body).toEqual({ upcoming: [], past: [] });
  });

  it('404s an unknown member id', async () => {
    await staff(request.get('/members/999999999/bookings')).expect(404);
  });

  it('answers the Upcoming list alone with scope=upcoming (#2731)', async () => {
    const res = await staff(request.get(`/members/${memberId}/bookings?scope=upcoming`)).expect(200);
    expect(Object.keys(res.body)).toEqual(['upcoming']);
    expect(res.body.upcoming.map((b: any) => b.id)).toEqual([ids.nearFuture, ids.farFuture]);
  });

  it('refuses an unknown scope', async () => {
    await staff(request.get(`/members/${memberId}/bookings?scope=past`)).expect(400);
  });
});

describe('GET /members/:memberId/bookings/past (#2731)', () => {
  let histMember: number;
  let centerA: number;
  let centerB: number;
  let trainer: number;
  let serviceId: number;
  let pilates: number;

  beforeAll(async () => {
    histMember = await member(gymId, 'History Member');
    centerA = (await db.query(`INSERT INTO centers (gym_id, name) VALUES (?, 'North')`, [gymId])).insertId;
    centerB = (await db.query(`INSERT INTO centers (gym_id, name) VALUES (?, 'South')`, [gymId])).insertId;
    trainer = (await db.query(
      `INSERT INTO gym_memberships (gym_id, user_id, role, name) VALUES (?, ?, 'trainer_performance', 'Tina Trainer')`,
      [gymId, `trainer-${Date.now()}`],
    )).insertId;
    serviceId = (await db.query(`INSERT INTO professional_services (gym_id, name) VALUES (?, 'Personal Training')`, [gymId])).insertId;
    pilates = (await db.query(
      `INSERT INTO activity_types (gym_id, name, duration_minutes, max_capacity, status) VALUES (?, 'Pilates', 60, 10, 'active')`,
      [gymId],
    )).insertId;

    // 230 past bookings: 150 Yoga at North (no service, attended), 80 Pilates at
    // South with Tina and Personal Training (half absent).
    const values: any[] = [];
    for (let i = 0; i < 230; i++) {
      const yoga = i < 150;
      const day = new Date(Date.UTC(2020, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
      const { insertId: ev } = await db.query(
        `INSERT INTO calendar_events (gym_id, title, activity_type_id, center_id, trainer_membership_id, capacity, starts_at, ends_at, status)
         VALUES (?, '', ?, ?, ?, 10, ?, ?, 'completed')`,
        [gymId, yoga ? activityId : pilates, yoga ? centerA : centerB, yoga ? null : trainer, `${day} 10:00:00`, `${day} 11:00:00`],
      );
      values.push(gymId, ev, histMember, yoga ? null : serviceId, yoga ? 'present' : (i % 2 ? 'absent' : 'present'));
    }
    const placeholders = Array.from({ length: 230 }, () => `(?, ?, ?, 'booked', ?, ?)`).join(', ');
    await db.query(
      `INSERT INTO calendar_event_bookings (gym_id, calendar_event_id, member_id, status, professional_service_id, attendance_status)
       VALUES ${placeholders}`,
      values,
    );
    // One upcoming booking that must never appear in the history.
    const { insertId: future } = await db.query(
      `INSERT INTO calendar_events (gym_id, title, activity_type_id, center_id, capacity, starts_at, ends_at, status)
       VALUES (?, '', ?, ?, 10, '2099-05-01 10:00:00', '2099-05-01 11:00:00', 'scheduled')`,
      [gymId, activityId, centerA],
    );
    await db.query(
      `INSERT INTO calendar_event_bookings (gym_id, calendar_event_id, member_id, status) VALUES (?, ?, ?, 'booked')`,
      [gymId, future, histMember],
    );
  });

  const past = (q = '') => staff(request.get(`/members/${histMember}/bookings/past${q}`));

  it('rejects an unauthenticated request and hides another gym\'s member', async () => {
    await request.get(`/members/${histMember}/bookings/past`).set('x-gym-id', gymId).expect(401);
    await staff(request.get(`/members/${histMember}/bookings/past`), otherGymId).expect(404);
  });

  it('pages the history 100 at a time, most recent first, with the total', async () => {
    const p1 = await past().expect(200);
    expect(p1.body).toMatchObject({ total: 230, page: 1, page_size: 100 });
    expect(p1.body.rows).toHaveLength(100);
    expect(p1.body.rows[0].starts_at > p1.body.rows[99].starts_at).toBe(true);
    const p3 = await past('?page=3').expect(200);
    expect(p3.body.rows).toHaveLength(30);
    const all = new Set([...p1.body.rows, ...(await past('?page=2')).body.rows, ...p3.body.rows].map((r: any) => r.id));
    expect(all.size).toBe(230);
  });

  it('applies the same past rule as the full read', async () => {
    const res = await past().set('x-gym-id', gymId);
    const legacy = await staff(request.get(`/members/${memberId}/bookings`)).expect(200);
    const paged = await staff(request.get(`/members/${memberId}/bookings/past`)).expect(200);
    expect(paged.body.rows.map((b: any) => b.id)).toEqual(legacy.body.past.map((b: any) => b.id));
    expect(paged.body.total).toBe(legacy.body.past.length);
    expect(res.body.rows.every((r: any) => r.starts_at < '2099')).toBe(true);
  });

  it('combines filters and counts what matches', async () => {
    const res = await past(`?activity_type_id=${pilates}&center_id=${centerB}&trainer_membership_id=${trainer}&professional_service_id=${serviceId}&status=absent`).expect(200);
    expect(res.body.total).toBe(40);
    expect(res.body.rows.every((r: any) => r.attendance_status === 'absent' && r.professional_service_name === 'Personal Training')).toBe(true);
    const yoga = await past(`?activity_type_id=${activityId}&status=present`).expect(200);
    expect(yoga.body.total).toBe(150);
    expect(yoga.body.rows[0].professional_service_name).toBeNull();
    const none = await past(`?activity_type_id=${activityId}&center_id=${centerB}`).expect(200);
    expect(none.body).toMatchObject({ total: 0, rows: [] });
  });

  it('reports filter options from the member\'s own history', async () => {
    const { options } = (await past()).body;
    expect(options.activities.map((o: any) => o.name)).toEqual(['Pilates', 'Yoga']);
    expect(options.centers.map((o: any) => o.id)).toEqual([centerA, centerB]);
    expect(options.trainers).toEqual([{ id: trainer, name: 'Tina Trainer' }]);
    expect(options.professional_services).toEqual([{ id: serviceId, name: 'Personal Training' }]);
    expect(options.statuses).toEqual(['booked', 'present', 'absent', 'waitlisted', 'cancelled']);
  });

  it('refuses malformed filters and pages', async () => {
    await past('?page=0').expect(400);
    await past('?center_id=abc').expect(400);
    await past('?status=gone').expect(400);
  });
});
