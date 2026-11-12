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
});
