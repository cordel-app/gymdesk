// #2125 M6b-4: the Professional Service wallet reads a Membership Plan assignment from
// `plan_snapshots`. The plan's own Session Benefits, the sessions an applied Promotion grants and
// the recurring session lines count while the assignment's current snapshot (the one the owner's
// Active Product Set links) entitles, for the Members that snapshot covers.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER, cleanupTestGyms, createTestDraftAssignment, createTestGym, createTestMembership, request,
} from './helpers';
import { loadMemberProfessionalServiceGrants } from '../domain/memberProfessionalServices';
import { CANCELS_AT_PERIOD_END_STATUS } from '../domain/assignmentStatus';
import { currentAssignmentSnapshotSql } from '../domain/planAssignments';

let gymId: string;
let otherGymId: string;
let serviceId: number;
let productId: number;
let centerId: number;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;
const auth = (r: any, gym = gymId) => r.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gym);
const must = (res: any, what: string) => {
  if (res.status >= 300) throw new Error(`${what}: ${res.status} ${JSON.stringify(res.body)}`);
  return res;
};

async function member(): Promise<number> {
  return Number(must(await auth(request.post('/members')).send({ name: 'Wallet Reader', email: `pwr-${uniq()}@test.com`, default_center_id: centerId }), 'member').body.id);
}
/** A plan that includes `sessions` sessions of the test Professional Service. */
async function plan(sessions = 4): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, ?, 'active', 'public', 2)`, [gymId, `PWR Plan ${uniq()}`]);
  await db.query(`INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
                  VALUES (?, ?, 10, '2020-01-01', 'active')`, [gymId, insertId]);
  await db.query(`INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
                  VALUES (?, ?, 1, 'month')`, [gymId, insertId]);
  if (sessions > 0) {
    await db.query('INSERT INTO membership_plan_session (gym_id, membership_plan_id, product_id, quantity) VALUES (?, ?, ?, ?)',
      [gymId, insertId, productId, sessions]);
  }
  return Number(insertId);
}
const activate = async (um: number) =>
  must(await auth(request.post(`/user-memberships/${um}/activate`)).send({ on_conflict: 'add' }), 'activate');
/** A member holding one running plan with four included sessions. */
async function running(sessions = 4): Promise<{ m: number; um: number; planId: number }> {
  const m = await member();
  const planId = await plan(sessions);
  const um = await createTestDraftAssignment(gymId, m, planId);
  await activate(um);
  return { m, um, planId };
}
const setStatus = async (um: number, status: 'paused' | 'active') =>
  must(await auth(request.put(`/user-memberships/${um}`)).send({ status }), status);
const draftOf = async (memberId: number): Promise<number> =>
  Number(must(await auth(request.post('/product-sets/draft')).send({ member_id: memberId }), 'draft').body.id);

/** The member's balance for the test service, as the staff wallet reports it. */
async function balance(memberId: number): Promise<number> {
  const res = must(await auth(request.get(`/members/${memberId}/professional-services/wallet`)), 'wallet');
  const row = (res.body as any[]).find((w) => w.professional_service_id === serviceId);
  return row ? Number(row.total_items) : 0;
}
const grants = async (memberId: number, kind: string) =>
  (await loadMemberProfessionalServiceGrants(gymId, memberId)).filter((g) => g.kind === kind && Number(g.sessions) > 0);

async function currentSnapshot(um: number) {
  const { rows } = await db.query<any>(
    `SELECT s.id, s.status FROM plan_snapshots a
       JOIN plan_snapshots s ON s.id = ${currentAssignmentSnapshotSql('a.assignment_id', 'a.gym_id')}
      WHERE a.gym_id = ? AND a.source_user_membership_id = ? LIMIT 1`, [gymId, um]);
  return rows[0];
}
/** Records one attended session spent from the member's plan grant, as the attendance writer does. */
async function spendOne(memberId: number): Promise<void> {
  const [grant] = await grants(memberId, 'plan_session');
  const { insertId: typeId } = await db.query(
    "INSERT INTO activity_types (gym_id, name, max_capacity, status, public_event) VALUES (?, ?, 10, 'active', 1)", [gymId, `PWR-${uniq()}`]);
  const { insertId: eventId } = await db.query(
    `INSERT INTO calendar_events (gym_id, activity_type_id, title, starts_at, ends_at, status, capacity)
     VALUES (?, ?, 'PWR', UTC_TIMESTAMP() - INTERVAL 2 DAY, UTC_TIMESTAMP() - INTERVAL 47 HOUR, 'scheduled', 10)`, [gymId, typeId]);
  const { insertId: bookingId } = await db.query(
    "INSERT INTO calendar_event_bookings (gym_id, calendar_event_id, member_id, status) VALUES (?, ?, ?, 'booked')", [gymId, eventId, memberId]);
  await db.query(
    `INSERT INTO professional_service_consumptions
       (gym_id, member_id, family_id, calendar_event_booking_id, calendar_event_id, professional_service_id,
        source_kind, source_reference_id, product_id, reason)
     VALUES (?, ?, (SELECT family_id FROM family_members WHERE member_id = ? AND gym_id = ?), ?, ?, ?, 'plan_session', ?, ?, 'attendance')`,
    [gymId, memberId, memberId, gymId, bookingId, eventId, serviceId, grant.reference_id, productId]);
}

beforeAll(async () => {
  gymId = await createTestGym('Assignment Wallet Reader Gym');
  otherGymId = await createTestGym('Assignment Wallet Reader Other Gym');
  await createTestMembership(gymId, 'admin');
  await createTestMembership(otherGymId, 'admin');
  ({ insertId: centerId } = await db.query('INSERT INTO centers (gym_id, name, status) VALUES (?, ?, ?)', [gymId, 'PWR Center', 'active']));
  ({ insertId: serviceId } = await db.query(
    'INSERT INTO professional_services (gym_id, name, is_system, system_key) VALUES (?, ?, 0, NULL)', [gymId, `PWR-PT-${uniq()}`]));
  await db.query("INSERT INTO gym_professional_services (gym_id, professional_service_id, status) VALUES (?, ?, 'active')", [gymId, serviceId]);
  ({ insertId: productId } = await db.query(
    `INSERT INTO products (gym_id, name, type, units, amount, currency, billing_frequency, status, availability, is_system)
     VALUES (?, ?, 'sessions', 1, 20.00, 'EUR', 'once', 'active', 'available', 0)`, [gymId, `PWR Session ${uniq()}`]));
  await db.query('INSERT INTO product_professional_services (gym_id, product_id, professional_service_id) VALUES (?, ?, ?)',
    [gymId, productId, serviceId]);
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('the plan\'s own sessions follow the assignment\'s current plan snapshot', () => {
  it('a running plan grants its sessions; another gym and an anonymous caller cannot read them', async () => {
    const { m } = await running();
    expect(await balance(m)).toBe(4);
    expect((await auth(request.get(`/members/${m}/professional-services/wallet`), otherGymId)).status).toBe(404);
    expect((await request.get(`/members/${m}/professional-services/wallet`)).status).toBe(401);
  });

  it('a Draft plan nobody committed grants nothing', async () => {
    const m = await member();
    await createTestDraftAssignment(gymId, m, await plan());
    expect(await balance(m)).toBe(0);
  });

  it('a plan that starts in the future grants nothing yet', async () => {
    const m = await member();
    const future = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
    const um = await createTestDraftAssignment(gymId, m, await plan(), { startsAt: future });
    await activate(um);
    expect(await balance(m)).toBe(0);
  });

  it('a pause takes the sessions away and a resume gives them back', async () => {
    const { m, um } = await running();
    await setStatus(um, 'paused');
    expect((await currentSnapshot(um)).status).toBe('paused');
    expect(await balance(m)).toBe(0);
    await setStatus(um, 'active');
    expect(await balance(m)).toBe(4);
  });

  it('a session already spent stays spent when a pause copies a snapshot a Draft also links', async () => {
    const { m, um } = await running();
    await spendOne(m);
    expect(await balance(m)).toBe(3);
    await draftOf(m);
    await setStatus(um, 'paused');
    await setStatus(um, 'active');
    expect(await balance(m)).toBe(3);
  });

  it('a cancelled plan keeps its sessions until its end date, and not after', async () => {
    const { m, um } = await running();
    must(await auth(request.delete(`/user-memberships/${um}`)), 'cancel');
    const current = await currentSnapshot(um);
    expect(current.status).toBe(CANCELS_AT_PERIOD_END_STATUS);
    expect(await balance(m)).toBe(4);
    await db.query('UPDATE plan_snapshots SET ends_at = UTC_DATE() - INTERVAL 1 DAY WHERE id = ?', [current.id]);
    expect(await balance(m)).toBe(0);
  });

  it('the snapshot is the record: a user_memberships row that disagrees does not move the balance', async () => {
    const { m, um } = await running();
    await db.query("UPDATE user_memberships SET status = 'cancelled', ends_at = UTC_DATE() - INTERVAL 1 DAY WHERE id = ?", [um]);
    expect(await balance(m)).toBe(4);
  });

  it('a covered Member holds the plan\'s sessions; the grant is not counted twice', async () => {
    const { m, um } = await running();
    const covered = await member();
    must(await auth(request.post(`/user-memberships/${um}/members`)).send({ member_id: covered }), 'cover');
    const held = await grants(covered, 'plan_session');
    expect(held.length).toBeGreaterThan(0);
    expect(held.every((g) => [m, covered].includes(Number(g.holder_member_id)))).toBe(true);
    const keys = held.map((g) => `${g.reference_id}:${g.holder_member_id}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('two plans of one Member both count', async () => {
    const { m } = await running();
    await activate(await createTestDraftAssignment(gymId, m, await plan(2)));
    expect(await balance(m)).toBe(6);
  });

  it('a plan replaced by another stops granting, also when two Product Sets shared its snapshot', async () => {
    const { m, um } = await running();
    // A second Product Set that reuses the plan unchanged: both link one snapshot.
    const draft = await draftOf(m);
    must(await auth(request.post(`/product-sets/${draft}/activate`)).send({}), 'activate unchanged');
    expect(await balance(m)).toBe(4);
    // Replace it with a plan that includes two sessions.
    const next = Number(must(await auth(request.post(`/user-memberships/${um}/assign-new-plan`))
      .send({ membership_plan_id: await plan(2), starts_at: new Date().toISOString().slice(0, 10) }), 'assign new').body.id);
    must(await auth(request.post(`/user-memberships/${next}/activate`)).send({ on_conflict: 'replace' }), 'replace');
    expect(await balance(m)).toBe(2);
  });
});

describe('the sessions a Promotion grants follow the same snapshot', () => {
  async function promotion(planId: number): Promise<number> {
    const { insertId } = await db.query(
      `INSERT INTO promotions (gym_id, name, starts_at, ends_at, lifecycle_status, stackable,
                               only_applicable_for_new_members, paid_months)
       VALUES (?, ?, '2026-01-01', '2099-12-31', 'active', 1, 0, 12)`, [gymId, `PWR Promo ${uniq()}`]);
    await db.query('INSERT INTO promotion_membership_plans (gym_id, promotion_id, membership_plan_id) VALUES (?, ?, ?)',
      [gymId, insertId, planId]);
    await db.query('INSERT INTO promotion_session (gym_id, promotion_id, product_id, quantity) VALUES (?, ?, ?, 3)',
      [gymId, insertId, productId]);
    return Number(insertId);
  }

  it('counts while the plan runs, not while it is a Draft or paused', async () => {
    const m = await member();
    const planId = await plan(0);
    const um = await createTestDraftAssignment(gymId, m, planId);
    must(await auth(request.post(`/user-memberships/${um}/promotions`)).send({ promotion_id: await promotion(planId) }), 'apply');
    expect(await balance(m)).toBe(0);
    await activate(um);
    expect(await balance(m)).toBe(3);
    expect(await grants(m, 'promotion_session')).toHaveLength(1);
    await setStatus(um, 'paused');
    expect(await balance(m)).toBe(0);
    await setStatus(um, 'active');
    expect(await balance(m)).toBe(3);
  });
});
