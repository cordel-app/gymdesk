// #2851 — a member with sessions left must be able to book them: a reservation
// whose booking no longer holds a unit (the occurrence was cancelled by a path
// that did not release it, or the session was already spent) does not make the
// balance read "all booked", and a family selection sent with no service picked
// books every selected member through the occurrence's one `family_only` service.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { verifyToken } from '@clerk/backend';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';
import { spendSessionForBooking } from '../api/service-consumption';
import { cancelOccurrencesByIds } from '../domain/scheduleEngine';

let gymId: string;
let centerId: number;
let ptActivity: number;
let familyActivity: number;
let ptService: number;
let familyService: number;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}`;
const headers = () => ({ Authorization: TEST_AUTH_HEADER, 'x-gym-id': gymId });

beforeAll(async () => {
  gymId = await createTestGym('Service Availability Gym');
  await createTestMembership(gymId, 'admin');
  ({ insertId: centerId } = await db.query('INSERT INTO centers (gym_id, name) VALUES (?, ?)', [gymId, `C-${uniq()}`]));
  ({ insertId: ptActivity } = await db.query(
    "INSERT INTO activity_types (gym_id, name, max_capacity, status, public_event) VALUES (?, 'PT', 10, 'active', 0)", [gymId]));
  ({ insertId: familyActivity } = await db.query(
    "INSERT INTO activity_types (gym_id, name, max_capacity, status, public_event) VALUES (?, 'Family PT', 10, 'active', 0)", [gymId]));
  ({ insertId: ptService } = await db.query(
    'INSERT INTO professional_services (gym_id, name, is_system, system_key) VALUES (?, ?, 0, NULL)', [gymId, `PT-${uniq()}`]));
  ({ insertId: familyService } = await db.query(
    "INSERT INTO professional_services (gym_id, name, is_system, system_key, max_capacity, min_participants, booking_type) VALUES (?, ?, 0, NULL, 4, 1, 'family_only')",
    [gymId, `Fam-${uniq()}`]));
  for (const [activity, service] of [[ptActivity, ptService], [familyActivity, familyService]]) {
    await db.query("INSERT INTO gym_professional_services (gym_id, professional_service_id, status) VALUES (?, ?, 'active')", [gymId, service]);
    await db.query('INSERT INTO activity_type_eligible_professional_services (gym_id, activity_type_id, professional_service_id) VALUES (?, ?, ?)',
      [gymId, activity, service]);
  }
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

async function member(name: string, clerkId: string | null = null): Promise<number> {
  if (clerkId) await createTestMembership(gymId, 'member', clerkId);
  const { insertId } = await db.query(
    'INSERT INTO members (gym_id, name, email, clerk_user_id) VALUES (?, ?, ?, ?)',
    [gymId, name, `sa-${uniq()}@test.com`, clerkId]);
  await db.query('INSERT INTO member_centers (gym_id, member_id, center_id, is_default, assigned_at) VALUES (?, ?, ?, 1, UTC_TIMESTAMP())',
    [gymId, insertId, centerId]);
  return insertId;
}
async function family(owner: number, others: number[]) {
  const { insertId } = await db.query('INSERT INTO families (gym_id, name) VALUES (?, ?)', [gymId, `F-${uniq()}`]);
  await db.query('INSERT INTO family_members (gym_id, family_id, member_id, is_owner) VALUES (?, ?, ?, 1)', [gymId, insertId, owner]);
  for (const m of others) {
    await db.query('INSERT INTO family_members (gym_id, family_id, member_id, is_owner) VALUES (?, ?, ?, 0)', [gymId, insertId, m]);
  }
}
async function grant(memberId: number, serviceId: number, sessions: number) {
  await db.query(
    `INSERT INTO professional_service_adjustments (gym_id, member_id, professional_service_id, delta, balance_before, balance_after, reason)
     VALUES (?, ?, ?, ?, 0, ?, 'test')`, [gymId, memberId, serviceId, sessions, sessions]);
}
async function event(activityTypeId: number): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO calendar_events (gym_id, center_id, title, activity_type_id, starts_at, ends_at, capacity, status)
     VALUES (?, ?, 'Session', ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 48 HOUR), DATE_ADD(UTC_TIMESTAMP(), INTERVAL 49 HOUR), 10, 'scheduled')`,
    [gymId, centerId, activityTypeId]);
  return insertId;
}
async function bookAs(clerkId: string, body: Record<string, unknown>) {
  vi.mocked(verifyToken).mockResolvedValueOnce({ sub: clerkId } as any);
  return request.post('/me/bookings').set(headers()).send(body);
}
async function mine(clerkId: string, serviceId: number) {
  vi.mocked(verifyToken).mockResolvedValueOnce({ sub: clerkId } as any);
  const res = await request.get('/me/professional-services').set(headers());
  return res.body.items.find((i: any) => i.professional_service_id === serviceId);
}
async function reservationStatus(bookingId: number): Promise<string> {
  const { rows } = await db.query('SELECT status FROM professional_service_reservations WHERE calendar_event_booking_id = ?', [bookingId]);
  return (rows as any[])[0]?.status;
}

describe('session availability (#2851)', () => {
  it('an occurrence cancelled without releasing its reservation does not hold the unit', async () => {
    const clerk = `sa-${uniq()}`;
    const me = await member('Solo', clerk);
    await grant(me, ptService, 1);
    const first = await event(ptActivity);
    const booked = await bookAs(clerk, { class_session_id: first, professional_service_id: ptService });
    expect(booked.status).toBe(201);
    expect(await mine(clerk, ptService)).toMatchObject({ remaining: 1, booked: 1, available: 0 });

    // A cancel path that never released the row (the state #2851 reported).
    await db.query("UPDATE calendar_events SET status = 'cancelled' WHERE id = ?", [first]);
    expect(await reservationStatus(booked.body.id)).toBe('reserved');
    expect(await mine(clerk, ptService)).toMatchObject({ remaining: 1, booked: 0, available: 1 });

    const next = await bookAs(clerk, { class_session_id: await event(ptActivity), professional_service_id: ptService });
    expect(next.status).toBe(201);
  });

  it('a schedule-engine cancellation releases the reservation', async () => {
    const clerk = `sa-${uniq()}`;
    const me = await member('Rule', clerk);
    await grant(me, ptService, 1);
    const ev = await event(ptActivity);
    const booked = await bookAs(clerk, { class_session_id: ev, professional_service_id: ptService });
    expect(booked.status).toBe(201);
    await cancelOccurrencesByIds([ev]);
    expect(await reservationStatus(booked.body.id)).toBe('released');
  });

  it('a spent session is not also counted as booked', async () => {
    const clerk = `sa-${uniq()}`;
    const me = await member('Spender', clerk);
    await grant(me, ptService, 3);
    const booked = await bookAs(clerk, { class_session_id: await event(ptActivity), professional_service_id: ptService });
    expect(booked.status).toBe(201);
    expect(await mine(clerk, ptService)).toMatchObject({ remaining: 3, booked: 1, available: 2 });

    const res = await db.transaction((tx) => spendSessionForBooking(tx, gymId, Number(booked.body.id), 'attendance', 'test'));
    expect(res.spent).toBe(true);
    expect(await reservationStatus(booked.body.id)).toBe('consumed');
    expect(await mine(clerk, ptService)).toMatchObject({ remaining: 2, booked: 0, available: 2 });
  });

  it('a family selection sent with no service picked books every selected member', async () => {
    const clerk = `sa-${uniq()}`;
    const parent = await member('Parent', clerk);
    const kid1 = await member('Kid One');
    const kid2 = await member('Kid Two');
    await family(parent, [kid1, kid2]);
    await grant(parent, familyService, 3);
    const ev = await event(familyActivity);

    const res = await bookAs(clerk, { class_session_id: ev, participant_member_ids: [kid1, kid2], booker_attends: true });
    expect(res.status).toBe(201);
    const { rows } = await db.query(
      "SELECT member_id, booked_by_member_id, professional_service_id FROM calendar_event_bookings WHERE calendar_event_id = ? AND status = 'booked'",
      [ev]);
    expect((rows as any[]).map((r) => r.member_id).sort()).toEqual([parent, kid1, kid2].sort());
    expect((rows as any[]).every((r) => r.booked_by_member_id === parent && r.professional_service_id === familyService)).toBe(true);
    // #2902: the family booking reserves one unit, however many members attend.
    expect(await mine(clerk, familyService)).toMatchObject({ remaining: 3, booked: 1, available: 2 });

    // A repeat registers nobody twice.
    const again = await bookAs(clerk, { class_session_id: ev, participant_member_ids: [kid1, kid2], booker_attends: true });
    expect(again.status).toBeGreaterThanOrEqual(400);
    const { rows: after } = await db.query(
      "SELECT COUNT(*) AS n FROM calendar_event_bookings WHERE calendar_event_id = ? AND status = 'booked'", [ev]);
    expect(Number((after as any[])[0].n)).toBe(3);
  });

  it('a parent who does not attend books only the selected children', async () => {
    const clerk = `sa-${uniq()}`;
    const parent = await member('Parent Two', clerk);
    const kid = await member('Kid Three');
    await family(parent, [kid]);
    await grant(parent, familyService, 2);
    const ev = await event(familyActivity);

    const res = await bookAs(clerk, { class_session_id: ev, participant_member_ids: [kid], booker_attends: false });
    expect(res.status).toBe(201);
    const { rows } = await db.query(
      "SELECT member_id FROM calendar_event_bookings WHERE calendar_event_id = ? AND status = 'booked'", [ev]);
    expect((rows as any[]).map((r) => r.member_id)).toEqual([kid]);
  });
});
