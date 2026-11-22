// #3180: GET /me/activity-history reports, per past booking, the caller's other Family members
// who attended (by name) and the number of attendees outside the Family (never their names).
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestFamily, createTestGym, request } from './helpers';

vi.mock('@clerk/backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@clerk/backend')>();
  return {
    ...actual,
    verifyToken: vi.fn().mockResolvedValue({ sub: 'test-user-id' }),
    createClerkClient: vi.fn(() => ({
      users: {
        getUser: vi.fn().mockResolvedValue({
          publicMetadata: { platform_role: 'superadmin' }, fullName: 'Super Admin', firstName: 'Super', lastName: 'Admin',
        }),
        getUserList: vi.fn().mockResolvedValue({ data: [], totalCount: 0 }),
      },
    })),
  };
});

let gymId: string;
let me: number;
let kid: number;
let absentKid: number;
let solo: number;
let eventId: number;
let emptyEventId: number;

const suffix = () => Math.random().toString(36).slice(2, 7);

async function member(name: string): Promise<number> {
  const { insertId } = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, name, `pba-${Date.now()}-${suffix()}@test.com`]);
  return insertId as number;
}
async function book(ev: number, memberId: number, status: string, attendance: string): Promise<void> {
  await db.query(
    `INSERT INTO calendar_event_bookings (gym_id, calendar_event_id, member_id, status, attendance_status)
     VALUES (?, ?, ?, ?, ?)`, [gymId, ev, memberId, status, attendance]);
}
async function history(memberId: number): Promise<any[]> {
  const res = await request.get('/me/activity-history')
    .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId).set('x-impersonate-as', `member:${memberId}`);
  expect(res.status).toBe(200);
  return res.body.items;
}

beforeAll(async () => {
  gymId = await createTestGym('Past Attendees Gym');
  const { insertId: at } = await db.query(
    "INSERT INTO activity_types (gym_id, name, max_capacity, status) VALUES (?, ?, 20, 'active')", [gymId, `AT-${suffix()}`]);
  const past = async () => (await db.query(
    `INSERT INTO calendar_events (gym_id, title, activity_type_id, starts_at, ends_at, status)
     VALUES (?, 'Session', ?, DATE_SUB(UTC_TIMESTAMP(), INTERVAL 48 HOUR), DATE_SUB(UTC_TIMESTAMP(), INTERVAL 47 HOUR), 'scheduled')`,
    [gymId, at])).insertId as number;
  eventId = await past();
  emptyEventId = await past();

  me = await member('Parent Member');
  kid = await member('Kid Attended');
  absentKid = await member('Kid Absent');
  solo = await member('Solo Member');
  const strangerA = await member('Stranger Present');
  const strangerB = await member('Stranger Pending');
  const strangerC = await member('Stranger Cancelled');
  await createTestFamily(gymId, me, [kid, absentKid]);

  await book(eventId, me, 'booked', 'present');
  await book(eventId, kid, 'booked', 'present');
  await book(eventId, absentKid, 'booked', 'absent');
  await book(eventId, solo, 'booked', 'present');
  await book(eventId, strangerA, 'booked', 'present');
  await book(eventId, strangerB, 'booked', 'pending');
  await book(eventId, strangerC, 'cancelled', 'pending');
  await book(emptyEventId, me, 'booked', 'pending');
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('GET /me/activity-history attendees (#3180)', () => {
  it('names the Family members who attended and only counts the rest', async () => {
    const item = (await history(me)).find((i) => i.entity_id === eventId);
    expect(item.family_attendees).toEqual([{ member_id: kid, name: 'Kid Attended' }]);
    // solo + Stranger Present; pending, absent and cancelled rows did not attend.
    expect(item.other_attendees_count).toBe(2);
    const body = JSON.stringify(item);
    expect(body).not.toContain('Stranger');
    expect(body).not.toContain('Solo Member');
  });

  it('reports an empty Family list and zero outsiders for an event nobody else attended', async () => {
    const item = (await history(me)).find((i) => i.entity_id === emptyEventId);
    expect(item.family_attendees).toEqual([]);
    expect(item.other_attendees_count).toBe(0);
  });

  it('gives a member with no Family no Family section, and counts the parent and kid as outsiders', async () => {
    const item = (await history(solo)).find((i) => i.entity_id === eventId);
    expect(item.family_attendees).toBeNull();
    expect(item.other_attendees_count).toBe(3);
    expect(JSON.stringify(item)).not.toContain('Kid Attended');
  });
});
