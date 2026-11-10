// #2567 stage 4 — a rectifying invoice is its own row and number linked to the
// original, which it cancels in full and never edits.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const stored = new Map<string, Buffer>();
vi.mock('../infra/private-storage', () => ({
  isPrivateStorageConfigured: () => true,
  putPrivateDocument: async (key: string, body: Buffer) => {
    if (stored.has(key)) throw new Error('already exists');
    stored.set(key, body); return key;
  },
  getPrivateDocument: async (key: string) => ({ body: stored.get(key)!, contentType: 'application/pdf' }),
  privateObjectExists: async (key: string) => stored.has(key),
}));

import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request, ensureTestProductSet, legacyAssignmentQuery,
} from './helpers';

afterAll(async () => { await cleanupTestGyms(); await db.end(); });

let gymA = ''; let gymB = ''; let eventId = 0;
const auth = (g: string) => ({ Authorization: TEST_AUTH_HEADER, 'x-gym-id': g });

beforeAll(async () => {
  gymA = await createTestGym('Rect A'); gymB = await createTestGym('Rect B');
  await createTestMembership(gymA, 'admin');
  const { insertId: memberId } = await db.query(
    `INSERT INTO members (gym_id, name, email) VALUES (?, 'Rect Member', ?)`, [gymA, `rect-${Date.now()}@test.com`]);
  const { insertId: planId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status) VALUES (?, ?, 'active', 'staff_only')`,
    [gymA, `Rect-Plan-${Date.now()}`]);
  const { insertId: umId } = await legacyAssignmentQuery(
    `INSERT INTO user_memberships (gym_id, member_id, membership_plan_id, status, starts_at, base_price)
     VALUES (?, ?, ?, 'active', '2020-01-01', '29.99')`, [gymA, memberId, planId]);
  const { rows: ct } = await db.query<{ id: number }>("SELECT id FROM charge_types WHERE code = 'membership_fee'");
  const r = await db.query(
    `INSERT INTO billing_events (gym_id, member_id, product_set_id, event_type, charge_type_id, source, actor_user_id, amount)
     VALUES (?, ?, ?, 'payment_recorded', ?, 'system', NULL, '29.99')`,
    [gymA, memberId, await ensureTestProductSet(gymA, memberId, umId), ct[0].id]);
  eventId = r.insertId;
});

describe('POST /invoices/:id/rectify', () => {
  let originalId = 0; let rectId = 0;
  it('issues, then rectifies with its own number and a negated PDF', async () => {
    const o = await request.post(`/payments/billing-events/${eventId}/invoices`).set(auth(gymA)).send({ invoice_type: 'simplified' });
    expect(o.status).toBe(201);
    originalId = o.body.id;
    const r = await request.post(`/payments/invoices/${originalId}/rectify`).set(auth(gymA)).send({ reason: 'wrong amount' });
    expect(r.status).toBe(201);
    rectId = r.body.id;
    expect(r.body.fiscal_number).toMatch(/^R-\d{4}-0001$/);
    expect(r.body.related_invoice_id).toBe(originalId);
    const { rows } = await db.query<any>('SELECT * FROM invoices WHERE id = ?', [originalId]);
    expect(rows[0].fiscal_number).toBe(o.body.fiscal_number); // original untouched
    const pdf = await request.get(`/payments/invoices/${rectId}/pdf`).set(auth(gymA));
    expect(pdf.status).toBe(200);
  });
  it('refuses a second rectification and rectifying a rectification', async () => {
    expect((await request.post(`/payments/invoices/${originalId}/rectify`).set(auth(gymA)).send({ reason: 'x' })).status).toBe(409);
    expect((await request.post(`/payments/invoices/${rectId}/rectify`).set(auth(gymA)).send({ reason: 'x' })).status).toBe(409);
  });
  it('requires a reason, auth and tenant isolation', async () => {
    expect((await request.post(`/payments/invoices/${originalId}/rectify`).set(auth(gymA)).send({})).status).toBe(400);
    expect((await request.post(`/payments/invoices/${originalId}/rectify`).send({ reason: 'x' })).status).toBe(401);
    await createTestMembership(gymB, 'admin', 'test-user-id');
    expect((await request.post(`/payments/invoices/${originalId}/rectify`).set(auth(gymB)).send({ reason: 'x' })).status).toBe(404);
  });
});
