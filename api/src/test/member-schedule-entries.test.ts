// #3090 stage 5 — CRUD of Professional Services Schedule entries:
// /members/:memberId/personal-training-slots/entries. An entry is a weekly slot
// plus the family members whose stored pattern holds it.
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


const api = (method: 'get' | 'post' | 'put' | 'delete', gymId: string, memberId: number, body?: unknown) => {
  const r = request[method](`/members/${memberId}/personal-training-slots/entries`)
    .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
  return body === undefined ? r : r.send(body as object);
};

async function weeklyEvents(gymId: string, at: number, sid: number, weekday: number, hour: number) {
  let cursor = DateTime.utc().minus({ days: 10 }).startOf('day');
  cursor = cursor.plus({ days: (weekday - cursor.weekday + 7) % 7 });
  const end = DateTime.utc().plus({ months: 2, days: 10 });
  for (; cursor < end; cursor = cursor.plus({ weeks: 1 })) {
    const start = cursor.set({ hour, minute: 0 });
    await db.query(
      `INSERT INTO calendar_events (gym_id, title, activity_type_id, professional_service_id, capacity, starts_at, ends_at, status)
       VALUES (?, ?, ?, ?, NULL, ?, ?, 'scheduled')`,
      [gymId, `Occ ${uniq()}`, at, sid, start.toFormat(SQL), start.plus({ hours: 1 }).toFormat(SQL)],
    );
  }
}

const identity = (slot: any) => ({
  weekday: slot.weekday, start_time: slot.start_time, end_time: slot.end_time,
  activity_type_id: slot.activity_type_id, professional_service_id: slot.professional_service_id,
  center_id: slot.center_id ?? null,
});

async function patternOf(gymId: string, memberId: number): Promise<string[]> {
  const { rows } = await db.query<any>(
    'SELECT iso_weekday, start_time FROM member_recurring_slots WHERE gym_id = ? AND member_id = ? ORDER BY iso_weekday, start_time',
    [gymId, memberId],
  );
  return rows.map((r: any) => `${r.iso_weekday}@${String(r.start_time).slice(0, 5)}`);
}

async function bookedCount(gymId: string, memberId: number): Promise<number> {
  const { rows } = await db.query<any>(
    "SELECT COUNT(*) AS n FROM calendar_event_bookings WHERE gym_id = ? AND member_id = ? AND status = 'booked'",
    [gymId, memberId],
  );
  return Number(rows[0].n);
}

describe('Professional Services Schedule entries', () => {
  let gymId: string;
  let a: number; let b: number; let outsider: number;
  let slot10: any; let slot12: any;
  let familySid: number; let familyAt: number; let familySlot: any;

  beforeAll(async () => {
    gymId = await createTestGym(`PTS Entries ${uniq()}`);
    await createTestMembership(gymId, 'admin');
    await db.query('UPDATE gyms SET timezone = ? WHERE id = ?', ['UTC', gymId]);
    a = await member(gymId); b = await member(gymId); outsider = await member(gymId);
    await createTestFamily(gymId, a, [b]);
    const { insertId: sid } = await db.query('INSERT INTO professional_services (gym_id, name, is_system, system_key) VALUES (?, ?, 0, NULL)', [gymId, `Svc-${uniq()}`]);
    await db.query(`INSERT INTO gym_professional_services (gym_id, professional_service_id, status) VALUES (?, ?, 'active')`, [gymId, sid]);
    const { insertId: at } = await db.query(`INSERT INTO activity_types (gym_id, name, max_capacity, public_event, status) VALUES (?, ?, 5, 0, 'active')`, [gymId, `Act-${uniq()}`]);
    await db.query('INSERT INTO activity_type_eligible_professional_services (gym_id, activity_type_id, professional_service_id) VALUES (?, ?, ?)', [gymId, at, sid]);
    await grantSessions(gymId, a, sid);

    // A family_only service that needs two participants.
    const { insertId: fsid } = await db.query(
      `INSERT INTO professional_services (gym_id, name, is_system, system_key, booking_type, min_participants) VALUES (?, ?, 0, NULL, 'family_only', 2)`,
      [gymId, `Duo-${uniq()}`],
    );
    familySid = fsid;
    await db.query(`INSERT INTO gym_professional_services (gym_id, professional_service_id, status) VALUES (?, ?, 'active')`, [gymId, fsid]);
    const { insertId: fat } = await db.query(`INSERT INTO activity_types (gym_id, name, max_capacity, public_event, status) VALUES (?, ?, 5, 0, 'active')`, [gymId, `Duo-${uniq()}`]);
    familyAt = fat;
    await db.query('INSERT INTO activity_type_eligible_professional_services (gym_id, activity_type_id, professional_service_id) VALUES (?, ?, ?)', [gymId, fat, fsid]);
    await grantSessions(gymId, a, fsid);

    const weekday = DateTime.utc().plus({ days: 3 }).weekday;
    await weeklyEvents(gymId, at, sid, weekday, 10);
    await weeklyEvents(gymId, at, sid, weekday, 12);
    await weeklyEvents(gymId, fat, fsid, weekday, 16);
    const res = await request.get(`/members/${a}/personal-training-slots`).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
    const slots = res.body.days.find((d: any) => d.weekday === weekday).slots;
    slot10 = slots.find((s: any) => s.start_time === '10:00' && s.professional_service_id === sid);
    slot12 = slots.find((s: any) => s.start_time === '12:00' && s.professional_service_id === sid);
    familySlot = slots.find((s: any) => s.professional_service_id === fsid);
  });

  it('creates an entry for several family members, storing their pattern and booking the window', async () => {
    const res = await api('post', gymId, a, { slot: identity(slot10), member_ids: [a, b] });
    expect(res.status).toBe(201);
    expect(res.body.created).toBeGreaterThan(0);
    expect(await patternOf(gymId, a)).toEqual([`${slot10.weekday}@10:00`]);
    expect(await patternOf(gymId, b)).toEqual([`${slot10.weekday}@10:00`]);
    expect(await bookedCount(gymId, b)).toBeGreaterThan(0);
    const entry = res.body.entries.find((e: any) => e.start_time === '10:00');
    expect(entry.members.map((m: any) => m.member_id).sort()).toEqual([a, b].sort());
    expect(entry.professional_service_name).toMatch(/^Svc-/);
  });

  it('lists the family entries from either member', async () => {
    const res = await api('get', gymId, b);
    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(1);
    expect(res.body.entries[0].members).toHaveLength(2);
  });

  it('edits an entry: moves it to another slot for the chosen members and keeps bookings made', async () => {
    const bookedBefore = await bookedCount(gymId, b);
    const res = await api('put', gymId, a, { previous_slot: identity(slot10), slot: identity(slot12), member_ids: [a] });
    expect(res.status).toBe(200);
    expect(await patternOf(gymId, a)).toEqual([`${slot12.weekday}@12:00`]);
    expect(await patternOf(gymId, b)).toEqual([]);
    // Future generation changes; bookings already made are not cancelled (#647 §5).
    expect(await bookedCount(gymId, b)).toBe(bookedBefore);
    expect(res.body.entries.map((e: any) => e.start_time)).toEqual(['12:00']);
  });

  it('edits only the members of an entry when the slot is unchanged', async () => {
    const res = await api('put', gymId, a, { previous_slot: identity(slot12), slot: identity(slot12), member_ids: [a, b] });
    expect(res.status).toBe(200);
    expect(await patternOf(gymId, b)).toEqual([`${slot12.weekday}@12:00`]);
    expect(res.body.entries[0].members).toHaveLength(2);
  });

  it('deletes an entry from every family member holding it', async () => {
    const res = await api('delete', gymId, a, { slot: identity(slot12) });
    expect(res.status).toBe(200);
    expect(res.body.entries).toEqual([]);
    expect(await patternOf(gymId, a)).toEqual([]);
    expect(await patternOf(gymId, b)).toEqual([]);
    expect((await api('delete', gymId, a, { slot: identity(slot12) })).status).toBe(404);
  });

  it('requires the family_only minimum of participants and writes nothing when refused', async () => {
    expect(familySlot.activity_type_id).toBe(familyAt);
    const refused = await api('post', gymId, a, { slot: identity(familySlot), member_ids: [a] });
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe('participants_below_minimum');
    expect(await patternOf(gymId, a)).toEqual([]);
    const ok = await api('post', gymId, a, { slot: identity(familySlot), member_ids: [a, b] });
    expect(ok.status).toBe(201);
    expect(ok.body.entries[0].professional_service_id).toBe(familySid);
    await api('delete', gymId, a, { slot: identity(familySlot) });
  });

  it('refuses a member outside the family, a slot not offered, and a missing entry', async () => {
    const outside = await api('post', gymId, a, { slot: identity(slot10), member_ids: [a, outsider] });
    expect(outside.status).toBe(400);
    expect(outside.body.code).toBe('member_not_in_family');
    const notOffered = await api('post', gymId, a, { slot: { ...identity(slot10), start_time: '05:00', end_time: '06:00' } });
    expect(notOffered.status).toBe(400);
    expect(notOffered.body.code).toBe('slot_not_available');
    const missing = await api('put', gymId, a, { previous_slot: identity(slot10), slot: identity(slot12) });
    expect(missing.status).toBe(404);
    expect((await api('post', gymId, a, { member_ids: [a] })).status).toBe(400);
    expect(await patternOf(gymId, a)).toEqual([]);
  });

  it('is tenant isolated and needs auth', async () => {
    const other = await createTestGym(`PTS Entries Other ${uniq()}`);
    await createTestMembership(other, 'admin');
    expect((await api('get', other, a)).status).toBe(404);
    expect((await request.get(`/members/${a}/personal-training-slots/entries`).set('x-gym-id', gymId)).status).toBe(401);
  });
});
