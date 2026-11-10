// #2604 stage 1: a booking's Professional Service reservation becomes the
// consumption when its event starts (the booking-reminders pass converts it).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { cleanupTestGyms, createTestGym, request } from './helpers';

const SECRET = 'test-booking-reminders-secret';
const run = () => request.post('/booking-reminders/run').set('X-Internal-Secret', SECRET);

let gymId: string;
let centerId: number;
let activityTypeId: number;
let serviceId: number;

beforeAll(async () => {
  process.env.BOOKING_REMINDERS_INTERNAL_SECRET = SECRET;
  gymId = await createTestGym();
  ({ insertId: centerId } = await db.query('INSERT INTO centers (gym_id, name) VALUES (?, ?)', [gymId, `C-${Date.now()}`]));
  ({ insertId: activityTypeId } = await db.query(
    "INSERT INTO activity_types (gym_id, name, max_capacity, status, public_event) VALUES (?, 'PT', 5, 'active', 0)", [gymId]));
  ({ insertId: serviceId } = await db.query(
    'INSERT INTO professional_services (gym_id, name, is_system, system_key) VALUES (?, ?, 0, NULL)', [gymId, `S-${Date.now()}`]));
  await db.query("INSERT INTO gym_professional_services (gym_id, professional_service_id, status) VALUES (?, ?, 'active')", [gymId, serviceId]);
  await db.query('INSERT INTO activity_type_eligible_professional_services (gym_id, activity_type_id, professional_service_id) VALUES (?, ?, ?)',
    [gymId, activityTypeId, serviceId]);
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

async function scenario(startsMinutes: number, eventStatus = 'scheduled') {
  const { insertId: memberId } = await db.query(
    "INSERT INTO members (gym_id, name, email) VALUES (?, 'ES Member', ?)", [gymId, `es-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.com`]);
  const { insertId: cpId } = await db.query(
    "INSERT INTO class_packages (gym_id, name, number_of_sessions, price, validity_days, status) VALUES (?, ?, 5, 50, 180, 'active')",
    [gymId, `P-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`]);
  const { insertId: productId } = await db.query(
    `INSERT INTO products (gym_id, name, type, units, amount, currency, billing_frequency, status, availability, is_system, class_package_id)
     VALUES (?, ?, 'sessions', 5, 50.00, 'EUR', NULL, 'active', 'available', 0, ?)`, [gymId, `Pr-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, cpId]);
  await db.query('INSERT INTO product_professional_services (gym_id, product_id, professional_service_id) VALUES (?, ?, ?)', [gymId, productId, serviceId]);
  const { insertId: ucpId } = await db.query(
    `INSERT INTO user_class_packages (gym_id, member_id, class_package_id, purchased_at, expires_at, sessions_remaining, status)
     VALUES (?, ?, ?, UTC_TIMESTAMP(), DATE_ADD(UTC_DATE(), INTERVAL 180 DAY), 5, 'active')`, [gymId, memberId, cpId]);
  const { insertId: eventId } = await db.query(
    `INSERT INTO calendar_events (gym_id, center_id, title, activity_type_id, starts_at, ends_at, status)
     VALUES (?, ?, 'PT', ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? MINUTE), DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? MINUTE), ?)`,
    [gymId, centerId, activityTypeId, startsMinutes, startsMinutes + 60, eventStatus]);
  const { insertId: bookingId } = await db.query(
    "INSERT INTO calendar_event_bookings (gym_id, calendar_event_id, member_id, status, booked_at) VALUES (?, ?, ?, 'booked', UTC_TIMESTAMP())",
    [gymId, eventId, memberId]);
  await db.query(
    `INSERT INTO professional_service_reservations
       (gym_id, member_id, calendar_event_booking_id, calendar_event_id, professional_service_id, source_kind, source_reference_id)
     VALUES (?, ?, ?, ?, ?, 'class_package', ?)`, [gymId, memberId, bookingId, eventId, serviceId, ucpId]);
  return { bookingId, ucpId };
}

const reservation = async (bookingId: number) =>
  (await db.query('SELECT status FROM professional_service_reservations WHERE calendar_event_booking_id = ?', [bookingId])).rows[0].status;
const spends = async (bookingId: number) =>
  (await db.query('SELECT reason FROM professional_service_consumptions WHERE calendar_event_booking_id = ?', [bookingId])).rows;
const remaining = async (id: number) =>
  Number((await db.query('SELECT sessions_remaining FROM user_class_packages WHERE id = ?', [id])).rows[0].sessions_remaining);

describe('event-start consumption (#2604)', () => {
  it('spends once when the event has started, and a second pass changes nothing', async () => {
    const { bookingId, ucpId } = await scenario(-10);
    const res = await run();
    expect(res.status).toBe(200);
    expect(res.body.reservations_consumed).toBeGreaterThanOrEqual(1);
    expect(await reservation(bookingId)).toBe('consumed');
    expect((await spends(bookingId)).map((r: any) => r.reason)).toEqual(['event_start']);
    expect(await remaining(ucpId)).toBe(4);
    await run();
    expect(await remaining(ucpId)).toBe(4);
    expect(await spends(bookingId)).toHaveLength(1);
  });

  it('spends nothing for an event that has not started', async () => {
    const { bookingId, ucpId } = await scenario(180);
    await run();
    expect(await reservation(bookingId)).toBe('reserved');
    expect(await spends(bookingId)).toHaveLength(0);
    expect(await remaining(ucpId)).toBe(5);
  });

  it('spends nothing for a cancelled event', async () => {
    const { bookingId, ucpId } = await scenario(-10, 'cancelled');
    await run();
    expect(await spends(bookingId)).toHaveLength(0);
    expect(await remaining(ucpId)).toBe(5);
  });
});
