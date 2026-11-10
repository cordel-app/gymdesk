// #2605 stage 3 — balances in the UI reads: the staff wallet and the member's
// own list report total = available + booked from the reservations a booking
// writes, the gate refuses the booking past the available balance, a staff
// adjustment sets the total, and the backfill gives a pre-model booking its
// reservation once.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { verifyToken } from '@clerk/backend';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';
import { backfillReservations } from '../api/service-reservation';

let gymId: string;
let centerId: number;
let activityTypeId: number;
let serviceId: number;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}`;
const headers = () => ({ Authorization: TEST_AUTH_HEADER, 'x-gym-id': gymId });

beforeAll(async () => {
  gymId = await createTestGym('Reservation Balances Gym');
  await createTestMembership(gymId, 'admin');
  ({ insertId: centerId } = await db.query('INSERT INTO centers (gym_id, name) VALUES (?, ?)', [gymId, `C-${uniq()}`]));
  ({ insertId: activityTypeId } = await db.query(
    "INSERT INTO activity_types (gym_id, name, max_capacity, status, public_event) VALUES (?, 'PT', 10, 'active', 0)", [gymId]));
  ({ insertId: serviceId } = await db.query(
    'INSERT INTO professional_services (gym_id, name, is_system, system_key) VALUES (?, ?, 0, NULL)', [gymId, `S-${uniq()}`]));
  await db.query("INSERT INTO gym_professional_services (gym_id, professional_service_id, status) VALUES (?, ?, 'active')", [gymId, serviceId]);
  await db.query('INSERT INTO activity_type_eligible_professional_services (gym_id, activity_type_id, professional_service_id) VALUES (?, ?, ?)',
    [gymId, activityTypeId, serviceId]);
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

async function member(clerkId: string | null = null): Promise<number> {
  if (clerkId) await createTestMembership(gymId, 'member', clerkId);
  const { insertId } = await db.query(
    'INSERT INTO members (gym_id, name, email, clerk_user_id) VALUES (?, ?, ?, ?)',
    [gymId, 'RB Member', `rb-${uniq()}@test.com`, clerkId]);
  await db.query('INSERT INTO member_centers (gym_id, member_id, center_id, is_default, assigned_at) VALUES (?, ?, ?, 1, UTC_TIMESTAMP())',
    [gymId, insertId, centerId]);
  return insertId;
}
async function grant(memberId: number, sessions: number) {
  await db.query(
    `INSERT INTO professional_service_adjustments (gym_id, member_id, professional_service_id, delta, balance_before, balance_after, reason)
     VALUES (?, ?, ?, ?, 0, ?, 'test')`, [gymId, memberId, serviceId, sessions, sessions]);
}
async function event(hours = 48): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO calendar_events (gym_id, center_id, title, activity_type_id, starts_at, ends_at, capacity, status)
     VALUES (?, ?, 'PT', ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? HOUR), DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? HOUR), 10, 'scheduled')`,
    [gymId, centerId, activityTypeId, hours, hours + 1]);
  return insertId;
}
const book = (memberId: number, eventId: number) =>
  request.post('/bookings').set(headers()).send({ member_id: memberId, class_session_id: eventId, professional_service_id: serviceId });
const wallet = async (memberId: number) =>
  (await request.get(`/members/${memberId}/professional-services/wallet`).set(headers())).body
    .find((w: any) => w.professional_service_id === serviceId);
async function mine(clerkId: string) {
  vi.mocked(verifyToken).mockResolvedValueOnce({ sub: clerkId } as any);
  const res = await request.get('/me/professional-services').set(headers());
  return res.body.items.find((i: any) => i.professional_service_id === serviceId);
}

describe('Professional Service balances with reservations (#2605 stage 3)', () => {
  it('reports total = available + booked on the wallet and the member list, and refuses past the available balance', async () => {
    const clerkId = `rb-${uniq()}`;
    const m = await member(clerkId);
    await grant(m, 2);
    expect(await wallet(m)).toMatchObject({ total_items: 2, booked_items: 0, available_items: 2 });

    expect((await book(m, await event())).status).toBe(201);
    expect(await wallet(m)).toMatchObject({ total_items: 2, booked_items: 1, available_items: 1 });
    expect(await mine(clerkId)).toMatchObject({ remaining: 2, booked: 1, available: 1, used: 0 });

    expect((await book(m, await event())).status).toBe(201);
    expect(await wallet(m)).toMatchObject({ total_items: 2, booked_items: 2, available_items: 0 });

    const refused = await book(m, await event());
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('no_available_balance');
    expect(await wallet(m)).toMatchObject({ total_items: 2, booked_items: 2, available_items: 0 });
  });

  it('a staff adjustment sets the total and the available follows the booked units', async () => {
    const m = await member();
    await grant(m, 1);
    expect((await book(m, await event())).status).toBe(201);
    const res = await request.post(`/members/${m}/professional-services/${serviceId}/adjust`).set(headers()).send({ new_balance: 3 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total_items: 3, booked_items: 1, available_items: 2, changed: true });
    expect(await wallet(m)).toMatchObject({ total_items: 3, booked_items: 1, available_items: 2 });
  });

  it('a cancelled booking releases its unit back to available', async () => {
    const m = await member();
    await grant(m, 1);
    const booked = await book(m, await event());
    expect(booked.status).toBe(201);
    expect(await wallet(m)).toMatchObject({ booked_items: 1, available_items: 0 });
    expect((await request.delete(`/bookings/${booked.body.id}`).set(headers())).status).toBe(204);
    expect(await wallet(m)).toMatchObject({ total_items: 1, booked_items: 0, available_items: 1 });
  });

  it('backfills a reservation for a pre-model future booking, once, and never for a partner row', async () => {
    const m = await member();
    await grant(m, 1);
    const eventId = await event();
    const { insertId: bookingId } = await db.query(
      `INSERT INTO calendar_event_bookings (gym_id, center_id, member_id, calendar_event_id, status, booked_at, professional_service_id)
       VALUES (?, ?, ?, ?, 'booked', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 DAY), ?)`, [gymId, centerId, m, eventId, serviceId]);
    const partner = await member();
    await grant(partner, 1);
    await db.query(
      `INSERT INTO calendar_event_bookings (gym_id, center_id, member_id, calendar_event_id, status, booked_at, professional_service_id, booked_by_member_id)
       VALUES (?, ?, ?, ?, 'booked', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 DAY), ?, ?)`, [gymId, centerId, partner, eventId, serviceId, m]);
    const before = new Date(Date.now() + 60_000).toISOString();

    const dry = await backfillReservations({ execute: false, before });
    expect(dry.reserved).toBeGreaterThanOrEqual(1);
    expect(await wallet(m)).toMatchObject({ booked_items: 0, available_items: 1 });

    await backfillReservations({ execute: true, before });
    expect(await wallet(m)).toMatchObject({ total_items: 1, booked_items: 1, available_items: 0 });
    expect(await wallet(partner)).toMatchObject({ booked_items: 0, available_items: 1 });
    const { rows } = await db.query('SELECT status FROM professional_service_reservations WHERE calendar_event_booking_id = ?', [bookingId]);
    expect(rows).toEqual([{ status: 'reserved' }]);

    const again = await backfillReservations({ execute: true, before });
    expect(again.candidates).toBe(0);
  });
});
