// #2657 stage 4 — the Individual plan lines committed before stage 3 are split per member by
// the operator script (`splitCommittedPlanLines()`): each member gets their own line with their
// units, a Shared line and a Draft's lines are left alone, a dry run writes nothing, a second run
// finds nothing, and a Session line's renewals and spends follow so the wallet does not move.
// Integration: the real routers and the module against MySQL.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { splitCommittedPlanLines } from '../api/plan-line-split-committed';
import { loadMemberProfessionalServiceGrants } from '../domain/memberProfessionalServices';
import {
  TEST_AUTH_HEADER, activateAssignment, cleanupTestGyms, createTestGym, createTestMembership, request,
} from './helpers';

let gymId: string;
let planId: number;
let centerId: number;
let lockerId: number; // Individual, periodical
let boxId: number; // Shared, periodical
let ptId: number; // Individual sessions Product granting a Professional Service
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;
const today = () => new Date().toISOString().slice(0, 10);
const as = (r: any) => r.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);

async function member(name: string): Promise<number> {
  const { insertId } = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, name, `plsc-${uniq()}@test.com`]);
  return Number(insertId);
}

async function product(name: string, sharing: 'individual' | 'shared', type = 'service'): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO products (gym_id, name, type, amount, currency, billing_frequency, status, enrollment_status, is_system, sharing_type, created_by)
     VALUES (?, ?, ?, 20, 'EUR', 'month', 'active', 'public', 0, ?, 'test')`, [gymId, name, type, sharing]);
  return Number(insertId);
}

async function duoDraft(): Promise<{ umId: number; owner: number; partner: number }> {
  const owner = await member(`Owner ${uniq()}`);
  const partner = await member(`Partner ${uniq()}`);
  await as(request.post(`/members/${owner}/family`)).send({});
  expect((await as(request.post(`/members/${owner}/family/members`)).send({ member_id: partner })).status).toBeLessThan(300);
  const res = await as(request.post('/user-memberships')).send({ member_id: owner, membership_plan_id: planId, starts_at: today() });
  expect(res.status).toBe(201);
  const umId = Number(res.body.id);
  expect((await as(request.post(`/user-memberships/${umId}/members`)).send({ member_id: partner })).status).toBe(201);
  return { umId, owner, partner };
}

async function activeSnapshot(owner: number): Promise<number> {
  const { rows: [r] } = await db.query<{ plan_snapshot_id: number }>(
    `SELECT psj.plan_snapshot_id FROM product_sets ps JOIN product_set_plan_snapshots psj ON psj.product_set_id = ps.id
      WHERE ps.owner_member_id = ? AND ps.status = 'active'`, [owner]);
  return Number(r.plan_snapshot_id);
}

/** Folds a product's split lines back into one unsplit line, as a pre-stage-3 commit left it. */
async function unsplit(table: string, snapshotId: number, productId: number): Promise<number> {
  const { rows } = await db.query<{ id: number; quantity: number }>(
    `SELECT id, quantity FROM ${table} WHERE plan_snapshot_id = ? AND product_id = ? ORDER BY id`, [snapshotId, productId]);
  const total = rows.reduce((s, r) => s + Number(r.quantity), 0);
  const keep = Number(rows[0].id);
  await db.query(`DELETE FROM ${table} WHERE plan_snapshot_id = ? AND product_id = ? AND id <> ?`, [snapshotId, productId, keep]);
  await db.query(`UPDATE ${table} SET assigned_member_id = NULL, quantity = ? WHERE id = ?`, [total, keep]);
  return keep;
}

async function linesOf(table: string, snapshotId: number, productId: number) {
  const { rows } = await db.query<{ id: number; assigned_member_id: number | null; quantity: number }>(
    `SELECT id, assigned_member_id, quantity FROM ${table} WHERE plan_snapshot_id = ? AND product_id = ? ORDER BY id`,
    [snapshotId, productId]);
  return rows.map((r) => ({ id: Number(r.id), member: r.assigned_member_id == null ? null : Number(r.assigned_member_id), quantity: Number(r.quantity) }));
}

const walletTotal = async (memberId: number) => (await loadMemberProfessionalServiceGrants(gymId, memberId))
  .filter((g) => g.kind === 'plan_session')
  .reduce((s, g) => s + Number(g.sessions), 0);

async function spend(memberId: number, lineId: number, serviceId: number): Promise<void> {
  const { insertId: eventId } = await db.query(
    `INSERT INTO calendar_events (gym_id, center_id, title, starts_at, ends_at, status)
     VALUES (?, ?, 'PT', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 2 DAY), DATE_SUB(UTC_TIMESTAMP(), INTERVAL 47 HOUR), 'completed')`,
    [gymId, centerId]);
  const { insertId: bookingId } = await db.query(
    `INSERT INTO calendar_event_bookings (gym_id, center_id, member_id, calendar_event_id, status, booked_at)
     VALUES (?, ?, ?, ?, 'booked', UTC_TIMESTAMP())`, [gymId, centerId, memberId, eventId]);
  await db.query(
    `INSERT INTO professional_service_consumptions
       (gym_id, member_id, calendar_event_booking_id, calendar_event_id, professional_service_id,
        source_kind, source_reference_id, product_id, reason)
     VALUES (?, ?, ?, ?, ?, 'plan_session', ?, ?, 'attendance')`,
    [gymId, memberId, bookingId, eventId, serviceId, lineId, ptId]);
}

let serviceId: number;

beforeAll(async () => {
  gymId = await createTestGym('Split committed plan lines gym');
  await createTestMembership(gymId, 'admin');
  const { insertId: c } = await db.query('INSERT INTO centers (gym_id, name) VALUES (?, ?)', [gymId, `C-${uniq()}`]);
  centerId = Number(c);
  lockerId = await product(`Locker ${uniq()}`, 'individual');
  boxId = await product(`Box ${uniq()}`, 'shared');
  ptId = await product(`PT ${uniq()}`, 'individual', 'sessions');
  const { insertId: s } = await db.query(
    'INSERT INTO professional_services (gym_id, name, is_system) VALUES (?, ?, 0)', [gymId, `PS-${uniq()}`]);
  serviceId = Number(s);
  await db.query(`INSERT INTO gym_professional_services (gym_id, professional_service_id, status) VALUES (?, ?, 'active')`, [gymId, serviceId]);
  await db.query('INSERT INTO product_professional_services (gym_id, product_id, professional_service_id) VALUES (?, ?, ?)', [gymId, ptId, serviceId]);
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, ?, 'active', 'public', 'family')`, [gymId, `Duo ${uniq()}`]);
  planId = Number(insertId);
  await db.query(
    `INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
     VALUES (?, ?, 50, '2020-01-01', 'active')`, [gymId, planId]);
  await db.query(
    `INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
     VALUES (?, ?, 1, 'month')`, [gymId, planId]);
  await db.query(
    `INSERT INTO membership_plan_periodical (gym_id, membership_plan_id, product_id, quantity, mandatory)
     VALUES (?, ?, ?, 2, 0), (?, ?, ?, 1, 0)`, [gymId, planId, lockerId, gymId, planId, boxId]);
  await db.query(
    `INSERT INTO membership_plan_session (gym_id, membership_plan_id, product_id, quantity, mandatory)
     VALUES (?, ?, ?, 2, 0)`, [gymId, planId, ptId]);
});

afterAll(async () => {
  await db.query('DELETE FROM professional_service_consumptions WHERE gym_id = ?', [gymId]);
  await db.query('DELETE FROM billing_events WHERE gym_id = ?', [gymId]);
  await cleanupTestGyms();
  await db.end();
});

describe('splitting committed Individual plan lines (#2657 stage 4)', () => {
  it('splits an Active plan\'s unsplit lines per member, keeps the Shared line, and runs once', async () => {
    const { umId, owner, partner } = await duoDraft();
    await activateAssignment(gymId, umId);
    const snap = await activeSnapshot(owner);
    const lockerLine = await unsplit('plan_periodical_snapshots', snap, lockerId);
    await unsplit('plan_session_snapshots', snap, ptId);

    // A dry run writes nothing.
    const dry = await splitCommittedPlanLines({ execute: false, gymId });
    expect(dry.lines).toBeGreaterThanOrEqual(2);
    expect(await linesOf('plan_periodical_snapshots', snap, lockerId)).toEqual([{ id: lockerLine, member: null, quantity: 2 }]);

    await splitCommittedPlanLines({ execute: true, gymId });
    const lockers = await linesOf('plan_periodical_snapshots', snap, lockerId);
    expect(lockers[0]).toEqual({ id: lockerLine, member: owner, quantity: 1 });
    expect(lockers.map((l) => [l.member, l.quantity]).sort()).toEqual([[owner, 1], [partner, 1]].sort());
    expect(await linesOf('plan_periodical_snapshots', snap, boxId)).toEqual([expect.objectContaining({ member: null, quantity: 1 })]);

    // The Assigned Plan reads the member lines.
    const res = await as(request.get(`/user-memberships/${umId}/periodical-benefits`));
    expect(res.status).toBe(200);
    expect(res.body.filter((l: any) => l.product_id === lockerId).map((l: any) => l.assigned_member_id).sort())
      .toEqual([owner, partner].sort());

    const again = await splitCommittedPlanLines({ execute: true, gymId });
    const { rows } = await db.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM plan_periodical_snapshots WHERE plan_snapshot_id = ? AND product_id = ?`, [snap, lockerId]);
    expect(Number(rows[0].n)).toBe(2);
    expect(again.lines).toBe(0);
  });

  it('leaves a Draft\'s unsplit lines for its own commit', async () => {
    const { umId } = await duoDraft();
    const { rows: [d] } = await db.query<{ plan_snapshot_id: number }>(
      `SELECT psj.plan_snapshot_id FROM product_sets ps JOIN product_set_plan_snapshots psj ON psj.product_set_id = ps.id
        WHERE ps.user_membership_id = ? AND ps.status = 'draft'`, [umId]);
    await splitCommittedPlanLines({ execute: true, gymId });
    expect(await linesOf('plan_periodical_snapshots', Number(d.plan_snapshot_id), lockerId))
      .toEqual([expect.objectContaining({ member: null, quantity: 2 })]);
  });

  it('shares a Session line\'s renewals and moves spends so the wallet does not change', async () => {
    const { umId, owner, partner } = await duoDraft();
    await activateAssignment(gymId, umId);
    const snap = await activeSnapshot(owner);
    const ptLine = await unsplit('plan_session_snapshots', snap, ptId);
    await db.query(
      `INSERT INTO plan_allowance_renewals (gym_id, plan_session_snapshot_id, renewal_date, quantity, created_by)
       VALUES (?, ?, ?, 2, 'System')`, [gymId, ptLine, today()]);
    for (let i = 0; i < 3; i++) await spend(owner, ptLine, serviceId);
    const before = await walletTotal(owner);

    await splitCommittedPlanLines({ execute: true, gymId });

    const pts = await linesOf('plan_session_snapshots', snap, ptId);
    expect(pts.map((l) => [l.member, l.quantity])).toEqual([[owner, 1], [partner, 1]]);
    const { rows: renewals } = await db.query<{ plan_session_snapshot_id: number; quantity: number }>(
      'SELECT plan_session_snapshot_id, quantity FROM plan_allowance_renewals WHERE plan_session_snapshot_id IN (?, ?) ORDER BY plan_session_snapshot_id',
      [pts[0].id, pts[1].id]);
    expect(renewals.map((r) => [Number(r.plan_session_snapshot_id), Number(r.quantity)])).toEqual([[pts[0].id, 1], [pts[1].id, 1]]);
    const { rows: spends } = await db.query<{ source_reference_id: number; n: number }>(
      `SELECT source_reference_id, COUNT(*) AS n FROM professional_service_consumptions
        WHERE gym_id = ? AND member_id = ? AND source_kind = 'plan_session' GROUP BY source_reference_id ORDER BY source_reference_id`,
      [gymId, owner]);
    expect(spends.map((r) => [Number(r.source_reference_id), Number(r.n)])).toEqual([[pts[0].id, 2], [pts[1].id, 1]]);
    expect(await walletTotal(owner)).toBe(before);
  });
});
