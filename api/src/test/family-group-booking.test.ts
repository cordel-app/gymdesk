// #2674 / #2813 — a member books a `family_only` Professional Service with the
// family members who attend: one individual booking per member (no group), each
// reserving its own unit, every rule enforced server-side; a cancellation that
// leaves the family below the service's minimum cancels the rest.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { verifyToken } from '@clerk/backend';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';

let gymId: string;
let centerId: number;
let activityTypeId: number;
let familyService: number;
let openService: number;
let familySoloService: number;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}`;
const headers = () => ({ Authorization: TEST_AUTH_HEADER, 'x-gym-id': gymId });

beforeAll(async () => {
  gymId = await createTestGym('Family Group Booking Gym');
  await createTestMembership(gymId, 'admin');
  ({ insertId: centerId } = await db.query('INSERT INTO centers (gym_id, name) VALUES (?, ?)', [gymId, `C-${uniq()}`]));
  ({ insertId: activityTypeId } = await db.query(
    "INSERT INTO activity_types (gym_id, name, max_capacity, status, public_event) VALUES (?, 'Family PT', 10, 'active', 0)", [gymId]));
  ({ insertId: familyService } = await db.query(
    "INSERT INTO professional_services (gym_id, name, is_system, system_key, max_capacity, min_participants, booking_type) VALUES (?, ?, 0, NULL, 3, 2, 'family_only')",
    [gymId, `Fam-${uniq()}`]));
  ({ insertId: openService } = await db.query(
    "INSERT INTO professional_services (gym_id, name, is_system, system_key, max_capacity, min_participants, booking_type) VALUES (?, ?, 0, NULL, 3, 2, 'open_group')",
    [gymId, `Open-${uniq()}`]));
  ({ insertId: familySoloService } = await db.query(
    "INSERT INTO professional_services (gym_id, name, is_system, system_key, max_capacity, min_participants, booking_type) VALUES (?, ?, 0, NULL, 3, 1, 'family_only')",
    [gymId, `FamSolo-${uniq()}`]));
  for (const s of [familyService, openService, familySoloService]) {
    await db.query("INSERT INTO gym_professional_services (gym_id, professional_service_id, status) VALUES (?, ?, 'active')", [gymId, s]);
    await db.query('INSERT INTO activity_type_eligible_professional_services (gym_id, activity_type_id, professional_service_id) VALUES (?, ?, ?)',
      [gymId, activityTypeId, s]);
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
    [gymId, name, `fg-${uniq()}@test.com`, clerkId]);
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
async function event(): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO calendar_events (gym_id, center_id, title, activity_type_id, starts_at, ends_at, capacity, status)
     VALUES (?, ?, 'Family PT', ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 48 HOUR), DATE_ADD(UTC_TIMESTAMP(), INTERVAL 49 HOUR), 10, 'scheduled')`,
    [gymId, centerId, activityTypeId]);
  return insertId;
}
function asMember(clerkId: string) {
  vi.mocked(verifyToken).mockResolvedValueOnce({ sub: clerkId } as any);
}
async function bookAs(clerkId: string, body: Record<string, unknown>) {
  asMember(clerkId);
  return request.post('/me/bookings').set(headers()).send(body);
}
async function bookings(eventId: number) {
  const { rows } = await db.query(
    "SELECT member_id, booking_group_id, booked_by_member_id, professional_service_id FROM calendar_event_bookings WHERE calendar_event_id = ? AND status = 'booked'",
    [eventId]);
  return rows as any[];
}
async function reservations(memberId: number) {
  const { rows } = await db.query(
    "SELECT COUNT(*) AS n FROM professional_service_reservations WHERE gym_id = ? AND member_id = ? AND status = 'reserved'", [gymId, memberId]);
  return Number((rows as any[])[0].n);
}

describe('family group booking (#2674)', () => {
  it('lists the caller\'s family, the caller first then alphabetically', async () => {
    const clerk = `fg-${uniq()}`;
    const me = await member('Zoe', clerk);
    const b = await member('Bea');
    const a = await member('Ann');
    await family(me, [b, a]);
    asMember(clerk);
    const res = await request.get('/me/family-members').set(headers());
    expect(res.status).toBe(200);
    expect(res.body.member_id).toBe(me);
    expect(res.body.members.map((m: any) => m.member_id)).toEqual([me, a, b]);
  });

  it('reports booking_type and min_participants on the event services', async () => {
    const clerk = `fg-${uniq()}`;
    const me = await member('Viewer', clerk);
    await grant(me, familyService, 1);
    const ev = await event();
    asMember(clerk);
    const res = await request.get('/me/schedule').set(headers());
    expect(res.status).toBe(200);
    const row = res.body.find((s: any) => s.id === ev);
    const svc = row.professional_services.find((s: any) => s.id === familyService);
    expect(svc).toMatchObject({ booking_type: 'family_only', min_participants: 2, capacity: 3 });
  });

  it('books every selected family member individually, each with their own reservation (#2813 §5)', async () => {
    const clerk = `fg-${uniq()}`;
    const me = await member('Parent', clerk);
    const kid1 = await member('Kid One');
    const kid2 = await member('Kid Two');
    await family(me, [kid1, kid2]);
    await grant(me, familyService, 3);
    const ev = await event();

    const res = await bookAs(clerk, { class_session_id: ev, professional_service_id: familyService, participant_member_ids: [kid1, kid2] });
    expect(res.status).toBe(201);
    expect(res.body.participant_booking_ids).toHaveLength(2);
    const rows = await bookings(ev);
    expect(rows.map((r) => r.member_id).sort()).toEqual([me, kid1, kid2].sort());
    expect(rows.every((r) => r.booking_group_id === null)).toBe(true);
    expect(rows.every((r) => r.booked_by_member_id === me && r.professional_service_id === familyService)).toBe(true);
    expect(await reservations(me) + await reservations(kid1) + await reservations(kid2)).toBe(3);

    // A repeated request books nothing more.
    const again = await bookAs(clerk, { class_session_id: ev, professional_service_id: familyService, participant_member_ids: [kid1, kid2] });
    expect(again.status).toBe(409);
    expect(await bookings(ev)).toHaveLength(3);
  });

  it('rolls every booking back when the family has fewer available units than attendees', async () => {
    const clerk = `fg-${uniq()}`;
    const me = await member('Short', clerk);
    const kid = await member('Kid');
    await family(me, [kid]);
    await grant(me, familyService, 1);
    const ev = await event();
    const res = await bookAs(clerk, { class_session_id: ev, professional_service_id: familyService, participant_member_ids: [kid] });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await bookings(ev)).toHaveLength(0);
  });

  it('takes a selection for a family_only service whose minimum is one (#2813 §1)', async () => {
    const clerk = `fg-${uniq()}`;
    const me = await member('Alone', clerk);
    const kid = await member('Kiddo');
    await family(me, [kid]);
    await grant(me, familySoloService, 2);
    const ev = await event();
    const res = await bookAs(clerk, { class_session_id: ev, professional_service_id: familySoloService, participant_member_ids: [kid] });
    expect(res.status).toBe(201);
    expect((await bookings(ev)).map((r) => r.member_id).sort()).toEqual([me, kid].sort());
  });

  it('keeps the others while the family meets the minimum, then cancels the last one below it (#2813 §6)', async () => {
    const clerk = `fg-${uniq()}`;
    const kidClerk = `fg-${uniq()}`;
    const me = await member('Mum', clerk);
    const kid1 = await member('Ada', kidClerk);
    const kid2 = await member('Ben');
    await family(me, [kid1, kid2]);
    await grant(me, familyService, 3);
    const ev = await event();
    const res = await bookAs(clerk, { class_session_id: ev, professional_service_id: familyService, participant_member_ids: [kid1, kid2] });
    expect(res.status).toBe(201);
    const idOf = async (m: number) => {
      const { rows } = await db.query('SELECT id FROM calendar_event_bookings WHERE calendar_event_id = ? AND member_id = ?', [ev, m]);
      return Number((rows as any[])[0].id);
    };

    // Two of three remain: min 2 is met, nothing else moves.
    asMember(kidClerk);
    const first = await request.delete(`/me/bookings/${await idOf(kid1)}`).set(headers());
    expect(first.status).toBe(204);
    expect((await bookings(ev)).map((r) => r.member_id).sort()).toEqual([me, kid2].sort());

    // One would remain: below min 2, so the last one is cancelled and told why.
    asMember(clerk);
    const second = await request.delete(`/me/bookings/${await idOf(me)}`).set(headers());
    expect(second.status).toBe(204);
    expect(await bookings(ev)).toHaveLength(0);
    expect(await reservations(me) + await reservations(kid1) + await reservations(kid2)).toBe(0);
    const { rows: alerts } = await db.query(
      "SELECT member_id FROM member_notifications WHERE gym_id = ? AND type = 'booking_cancelled_by_partner' AND entity_id = ?", [gymId, ev]);
    expect((alerts as any[]).map((a) => Number(a.member_id))).toEqual([kid2]);
  });

  it('refuses a selection below the minimum, above the maximum or outside the family, booking nothing', async () => {
    const clerk = `fg-${uniq()}`;
    const me = await member('Solo', clerk);
    const k1 = await member('K1');
    const k2 = await member('K2');
    const k3 = await member('K3');
    const outsider = await member('Outsider');
    await family(me, [k1, k2, k3]);
    await grant(me, familyService, 5);
    const ev = await event();

    const below = await bookAs(clerk, { class_session_id: ev, professional_service_id: familyService });
    expect(below.status).toBe(400);
    expect(below.body.code).toBe('participants_below_minimum');

    const above = await bookAs(clerk, { class_session_id: ev, professional_service_id: familyService, participant_member_ids: [k1, k2, k3] });
    expect(above.status).toBe(400);
    expect(above.body.code).toBe('participants_above_maximum');

    const stranger = await bookAs(clerk, { class_session_id: ev, professional_service_id: familyService, participant_member_ids: [outsider] });
    expect(stranger.status).toBe(403);
    expect(stranger.body.code).toBe('participant_not_in_family');

    expect(await bookings(ev)).toHaveLength(0);
    expect(await reservations(me)).toBe(0);
  });

  it('rolls every booking back when the booker has no available unit', async () => {
    const clerk = `fg-${uniq()}`;
    const me = await member('Broke', clerk);
    const kid = await member('Kid');
    await family(me, [kid]);
    const ev = await event();
    const res = await bookAs(clerk, { class_session_id: ev, professional_service_id: familyService, participant_member_ids: [kid] });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await bookings(ev)).toHaveLength(0);
  });

  it('leaves an open_group service on the existing path', async () => {
    const clerk = `fg-${uniq()}`;
    const me = await member('Open', clerk);
    await grant(me, openService, 1);
    const ev = await event();
    const res = await bookAs(clerk, { class_session_id: ev, professional_service_id: openService });
    expect(res.status).toBe(201);
    expect(await bookings(ev)).toHaveLength(1);
  });
});

describe('booker may book only for family members (#2850)', () => {
  it('books the children alone when the booker does not attend', async () => {
    const clerk = `fg-${uniq()}`;
    const me = await member('Parent Out', clerk);
    const kid1 = await member('Kid A');
    const kid2 = await member('Kid B');
    await family(me, [kid1, kid2]);
    await grant(me, familyService, 3);
    const ev = await event();

    const res = await bookAs(clerk, {
      class_session_id: ev, professional_service_id: familyService, participant_member_ids: [kid1, kid2], booker_attends: false,
    });
    expect(res.status).toBe(201);
    expect(res.body.booker_attends).toBe(false);
    expect(res.body.participant_booking_ids).toHaveLength(2);
    const rows = await bookings(ev);
    expect(rows.map((r) => r.member_id).sort()).toEqual([kid1, kid2].sort());
    expect(rows.every((r) => r.booked_by_member_id === me)).toBe(true);
  });

  it('still books the booker with the children by default and when they attend', async () => {
    const clerk = `fg-${uniq()}`;
    const me = await member('Parent In', clerk);
    const kid = await member('Kid C');
    await family(me, [kid]);
    await grant(me, familyService, 2);
    const ev = await event();
    const res = await bookAs(clerk, {
      class_session_id: ev, professional_service_id: familyService, participant_member_ids: [kid], booker_attends: true,
    });
    expect(res.status).toBe(201);
    expect((await bookings(ev)).map((r) => r.member_id).sort()).toEqual([me, kid].sort());
  });

  it('counts the minimum without the booker who does not attend, and refuses an empty booking', async () => {
    const clerk = `fg-${uniq()}`;
    const me = await member('Parent Min', clerk);
    const kid = await member('Kid D');
    await family(me, [kid]);
    await grant(me, familyService, 2);
    await grant(me, familySoloService, 2);
    const ev = await event();

    const below = await bookAs(clerk, {
      class_session_id: ev, professional_service_id: familyService, participant_member_ids: [kid], booker_attends: false,
    });
    expect(below.status).toBe(400);
    expect(below.body.error).toMatch(/more participants/);

    const empty = await bookAs(clerk, {
      class_session_id: ev, professional_service_id: familySoloService, participant_member_ids: [], booker_attends: false,
    });
    expect(empty.status).toBe(400);

    const solo = await bookAs(clerk, {
      class_session_id: ev, professional_service_id: familySoloService, participant_member_ids: [kid], booker_attends: false,
    });
    expect(solo.status).toBe(201);
    expect((await bookings(ev)).map((r) => r.member_id)).toEqual([kid]);
  });

  it('refuses a booker_attends that is not a boolean', async () => {
    const clerk = `fg-${uniq()}`;
    const me = await member('Parent Bad', clerk);
    const kid = await member('Kid E');
    await family(me, [kid]);
    await grant(me, familyService, 2);
    const ev = await event();
    const res = await bookAs(clerk, {
      class_session_id: ev, professional_service_id: familyService, participant_member_ids: [kid], booker_attends: 'false',
    });
    expect(res.status).toBe(400);
    expect(await bookings(ev)).toHaveLength(0);
  });
});
