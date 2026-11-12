// #2670 stage 2 — the Professional Services wallet belongs to the Family: every member of
// a family reads the same balance and the same history, a booking by any of them spends
// one unit from it, and a correction entered from one member's card is the family's.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { verifyToken } from '@clerk/backend';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';

let gymId: string;
let centerId: number;
let activityTypeId: number;
let serviceId: number;
let classPackageId: number;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}`;
const headers = () => ({ Authorization: TEST_AUTH_HEADER, 'x-gym-id': gymId });

beforeAll(async () => {
  gymId = await createTestGym('Family Wallet Gym');
  await createTestMembership(gymId, 'admin');
  ({ insertId: centerId } = await db.query('INSERT INTO centers (gym_id, name) VALUES (?, ?)', [gymId, `C-${uniq()}`]));
  ({ insertId: activityTypeId } = await db.query(
    "INSERT INTO activity_types (gym_id, name, max_capacity, status, public_event) VALUES (?, 'PT', 10, 'active', 0)", [gymId]));
  ({ insertId: serviceId } = await db.query(
    "INSERT INTO professional_services (gym_id, name, is_system, system_key, max_capacity) VALUES (?, ?, 0, NULL, 10)",
    [gymId, `PT-${uniq()}`]));
  await db.query("INSERT INTO gym_professional_services (gym_id, professional_service_id, status) VALUES (?, ?, 'active')", [gymId, serviceId]);
  await db.query('INSERT INTO activity_type_eligible_professional_services (gym_id, activity_type_id, professional_service_id) VALUES (?, ?, ?)',
    [gymId, activityTypeId, serviceId]);
  ({ insertId: classPackageId } = await db.query(
    "INSERT INTO class_packages (gym_id, name, number_of_sessions, price, validity_days, status) VALUES (?, ?, 10, 100.00, 365, 'active')",
    [gymId, `Pack-${uniq()}`]));
  const { insertId: productId } = await db.query(
    `INSERT INTO products (gym_id, name, type, units, amount, currency, billing_frequency, status, availability, is_system, class_package_id)
     VALUES (?, ?, 'sessions', 10, 100.00, 'EUR', NULL, 'active', 'available', 0, ?)`,
    [gymId, `PackProduct-${uniq()}`, classPackageId]);
  await db.query('INSERT INTO product_professional_services (gym_id, product_id, professional_service_id) VALUES (?, ?, ?)',
    [gymId, productId, serviceId]);
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

/** A member created through the API, so they get their solo family exactly as in production. */
async function member(name: string, clerkId: string | null = null): Promise<number> {
  const res = await request.post('/members').set(headers()).send({ name, email: `fw-${uniq()}@test.com` });
  expect(res.status).toBe(201);
  const id = Number(res.body.id);
  if (clerkId) {
    await createTestMembership(gymId, 'member', clerkId);
    await db.query('UPDATE members SET clerk_user_id = ? WHERE id = ?', [clerkId, id]);
  }
  await db.query('INSERT IGNORE INTO member_centers (gym_id, member_id, center_id, is_default, assigned_at) VALUES (?, ?, ?, 1, UTC_TIMESTAMP())',
    [gymId, id, centerId]);
  return id;
}
async function join(ownerId: number, otherId: number) {
  const res = await request.post(`/members/${ownerId}/family/members`).set(headers()).send({ member_id: otherId });
  expect(res.status).toBe(201);
}
async function buyPackage(memberId: number, sessions: number) {
  await db.query(
    `INSERT INTO user_class_packages (gym_id, member_id, class_package_id, expires_at, sessions_remaining, status)
     VALUES (?, ?, ?, DATE_ADD(UTC_DATE(), INTERVAL 90 DAY), ?, 'active')`,
    [gymId, memberId, classPackageId, sessions]);
}
async function wallet(memberId: number) {
  const res = await request.get(`/members/${memberId}/professional-services/wallet`).set(headers());
  expect(res.status).toBe(200);
  const row = res.body.find((s: any) => s.professional_service_id === serviceId);
  return { total: row.total_items, booked: row.booked_items, available: row.available_items };
}
async function history(memberId: number) {
  const res = await request.get(`/members/${memberId}/professional-services/${serviceId}/history`).set(headers());
  expect(res.status).toBe(200);
  return res.body as any[];
}
async function adjust(memberId: number, newBalance: number) {
  const res = await request.post(`/members/${memberId}/professional-services/${serviceId}/adjust`).set(headers())
    .send({ new_balance: newBalance, reason: 'test' });
  expect(res.status).toBe(200);
  return res.body;
}
async function event(): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO calendar_events (gym_id, center_id, title, activity_type_id, starts_at, ends_at, capacity, status)
     VALUES (?, ?, 'PT', ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 48 HOUR), DATE_ADD(UTC_TIMESTAMP(), INTERVAL 49 HOUR), 10, 'scheduled')`,
    [gymId, centerId, activityTypeId]);
  return insertId;
}
async function bookAs(clerkId: string, eventId: number) {
  vi.mocked(verifyToken).mockResolvedValueOnce({ sub: clerkId } as any);
  const res = await request.post('/me/bookings').set(headers()).send({ class_session_id: eventId, professional_service_id: serviceId });
  expect(res.status).toBe(201);
  const { rows } = await db.query(
    "SELECT id FROM calendar_event_bookings WHERE calendar_event_id = ? AND status = 'booked' ORDER BY id DESC LIMIT 1", [eventId]);
  return Number((rows as any[])[0].id);
}

describe('Family Professional Services wallet (#2670 stage 2)', () => {
  it('every member of a family reads the same balance, and another family is independent', async () => {
    const parent = await member('Parent A');
    const kid = await member('Kid A');
    const stranger = await member('Stranger A');
    await join(parent, kid);
    await buyPackage(parent, 5);
    await buyPackage(kid, 2);
    await buyPackage(stranger, 3);

    // The family's balance is the sum of what its members held: nothing lost, nothing doubled.
    expect(await wallet(parent)).toEqual({ total: 7, booked: 0, available: 7 });
    expect(await wallet(kid)).toEqual({ total: 7, booked: 0, available: 7 });
    expect(await wallet(stranger)).toEqual({ total: 3, booked: 0, available: 3 });
  });

  it('a booking by one member reserves and then spends one unit of the family wallet, seen from every member', async () => {
    const parentClerk = `fw-${uniq()}`;
    const kidClerk = `fw-${uniq()}`;
    const parent = await member('Parent B', parentClerk);
    const kid = await member('Kid B', kidClerk);
    await join(parent, kid);
    await buyPackage(parent, 3); // only the parent holds a grant

    const ev1 = await event();
    const kidBooking = await bookAs(kidClerk, ev1);
    expect(await wallet(parent)).toEqual({ total: 3, booked: 1, available: 2 });
    expect(await wallet(kid)).toEqual({ total: 3, booked: 1, available: 2 });

    const ev2 = await event();
    await bookAs(parentClerk, ev2);
    expect(await wallet(kid)).toEqual({ total: 3, booked: 2, available: 1 });

    // Attendance spends exactly one unit, once, from the family wallet.
    for (let i = 0; i < 2; i++) {
      const att = await request.post(`/bookings/${kidBooking}/attendance`).set(headers()).send({ status: 'present' });
      expect(att.status).toBe(200);
    }
    const { rows } = await db.query(
      'SELECT member_id, family_id FROM professional_service_consumptions WHERE calendar_event_booking_id = ?', [kidBooking]);
    expect(rows).toHaveLength(1);
    const { rows: fam } = await db.query('SELECT family_id FROM family_members WHERE member_id = ?', [kid]);
    expect(Number((rows as any[])[0].family_id)).toBe(Number((fam as any[])[0].family_id));
    expect(await wallet(parent)).toMatchObject({ total: 2 });
    expect(await wallet(kid)).toMatchObject({ total: 2 });

    // The spend is in the history of every member, naming the member who booked.
    for (const viewer of [parent, kid]) {
      const spends = (await history(viewer)).filter((e) => e.kind === 'consumption');
      expect(spends).toHaveLength(1);
      expect(spends[0]).toMatchObject({ quantity: -1, member_id: kid, member_name: 'Kid B' });
    }
  });

  it('two members of one family booking the same event spend one unit each', async () => {
    const aClerk = `fw-${uniq()}`;
    const bClerk = `fw-${uniq()}`;
    const a = await member('Twin A', aClerk);
    const b = await member('Twin B', bClerk);
    await join(a, b);
    await buyPackage(a, 2);
    const ev = await event();
    const ba = await bookAs(aClerk, ev);
    const bb = await bookAs(bClerk, ev);
    expect(await wallet(b)).toEqual({ total: 2, booked: 2, available: 0 });

    // Nothing is left to book for anyone in the family.
    vi.mocked(verifyToken).mockResolvedValueOnce({ sub: aClerk } as any);
    const third = await request.post('/me/bookings').set(headers()).send({ class_session_id: await event(), professional_service_id: serviceId });
    expect(third.status).toBe(409);

    for (const id of [ba, bb]) {
      expect((await request.post(`/bookings/${id}/attendance`).set(headers()).send({ status: 'present' })).status).toBe(200);
    }
    expect(await wallet(a)).toEqual({ total: 0, booked: 0, available: 0 });
  });

  it('a correction entered from one member is the family\'s balance and history', async () => {
    const parent = await member('Parent C');
    const kid = await member('Kid C');
    await join(parent, kid);
    await buyPackage(parent, 2);

    const res = await adjust(kid, 5);
    expect(res).toMatchObject({ total_items: 5, changed: true });
    expect(await wallet(parent)).toMatchObject({ total: 5 });
    // Setting the same balance from the other member changes nothing.
    expect(await adjust(parent, 5)).toMatchObject({ changed: false });

    for (const viewer of [parent, kid]) {
      const adjustments = (await history(viewer)).filter((e) => e.kind === 'adjustment');
      expect(adjustments).toHaveLength(1);
      expect(adjustments[0]).toMatchObject({ quantity: 3, balance_before: 2, balance_after: 5, member_id: kid });
    }
  });

  it('a solo member who joins a family brings their corrections, and dissolving returns them', async () => {
    const owner = await member('Owner D');
    const joiner = await member('Joiner D');
    await adjust(joiner, 4); // recorded while the joiner is alone
    expect(await wallet(owner)).toMatchObject({ total: 0 });

    await join(owner, joiner);
    expect(await wallet(owner)).toMatchObject({ total: 4 });
    expect((await history(owner)).filter((e) => e.kind === 'adjustment')).toHaveLength(1);

    const res = await request.delete(`/members/${owner}/family`).set(headers());
    expect(res.status).toBe(204);
    expect(await wallet(owner)).toMatchObject({ total: 0 });
    expect(await wallet(joiner)).toMatchObject({ total: 4 });
    const { rows } = await db.query(
      `SELECT psa.family_id = fm.family_id AS same
         FROM professional_service_adjustments psa JOIN family_members fm ON fm.member_id = psa.member_id
        WHERE psa.member_id = ?`, [joiner]);
    expect((rows as any[]).every((r) => Number(r.same) === 1)).toBe(true);
  });

  it('a member removed from a family takes their own grants and leaves the family\'s corrections', async () => {
    const owner = await member('Owner E');
    const leaver = await member('Leaver E');
    await join(owner, leaver);
    await buyPackage(leaver, 2);
    await adjust(owner, 5); // +3 correction on the family wallet

    const res = await request.delete(`/members/${owner}/family/members/${leaver}`).set(headers());
    expect(res.status).toBe(200);
    expect(await wallet(leaver)).toMatchObject({ total: 2 });
    expect(await wallet(owner)).toMatchObject({ total: 3 });
  });
});
