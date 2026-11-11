// #2609 stage 1 — an Individual Product bought or assigned for a member is for one
// family member: the staff purchase (draft), the recurring Draft line and the
// purchases list carry `assigned_member_id`, and the server refuses an outsider.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { cleanupTestGyms, createTestGym, insertTestPurchase, createTestMembership, request, TEST_AUTH_HEADER } from './helpers';

let gymId: string;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;
const auth = (r: any) => r.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
const base = (memberId: number) => `/members/${memberId}/product-purchases`;

async function member(name: string): Promise<number> {
  const { insertId } = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, name, `pa-${uniq()}@test.com`]);
  return insertId;
}

async function product(name: string, opts: { frequency?: string; sharing?: 'individual' | 'shared' } = {}): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO products
       (gym_id, name, type, billing_frequency, status, enrollment_status, is_system, currency, amount, tax_behavior, sharing_type)
     VALUES (?, ?, 'fee', ?, 'active', 'public', 0, 'EUR', '30.00', 'inclusive', ?)`,
    [gymId, name, opts.frequency ?? 'once', opts.sharing ?? 'individual']);
  return insertId;
}

let owner: number;
let kid: number;
let stranger: number;
let loner: number;
let oneOff: number;
let shared: number;
let monthly: number;

beforeAll(async () => {
  gymId = await createTestGym('Product assignee gym');
  await createTestMembership(gymId);
  owner = await member('Assignee Owner');
  kid = await member('Assignee Kid');
  stranger = await member('Assignee Stranger');
  loner = await member('Assignee Loner');
  await auth(request.post(`/members/${owner}/family`)).send({});
  await auth(request.post(`/members/${owner}/family/members`)).send({ member_id: kid });
  oneOff = await product(`Locker ${uniq()}`);
  shared = await product(`Family box ${uniq()}`, { sharing: 'shared' });
  monthly = await product(`Parking ${uniq()}`, { frequency: 'month' });
});

afterAll(async () => {
  await db.query('DELETE FROM member_products_oneoff_snapshot WHERE gym_id = ?', [gymId]);
  await cleanupTestGyms();
  await db.end();
});

describe('eligible assignees', () => {
  it('lists the family, owner first, and nobody for a member with no family', async () => {
    const fam = await auth(request.get(`${base(owner)}/assignees`));
    expect(fam.status).toBe(200);
    expect(fam.body.members.map((m: any) => [m.member_id, m.is_owner])).toEqual([[owner, true], [kid, false]]);
    const none = await auth(request.get(`${base(loner)}/assignees`));
    expect(none.body.members).toEqual([]);
    expect((await auth(request.get(`${base(999999)}/assignees`))).status).toBe(404);
  });
});

describe('one-time purchase', () => {
  it('stores the chosen family member and reports it on the purchases list', async () => {
    const res = await auth(request.post(base(owner))).send({ product_id: oneOff, draft: true, assigned_member_id: kid });
    expect(res.status).toBe(201);
    const { rows } = await db.query<any>(
      'SELECT assigned_member_id FROM member_products_oneoff_snapshot WHERE id = ?', [res.body.purchaseId]);
    expect(rows[0].assigned_member_id).toBe(kid);
    const { rows: mirror } = await db.query<any>(
      'SELECT assigned_member_id FROM product_oneoff_snapshots WHERE source_id = ?', [res.body.purchaseId]);
    expect(mirror[0].assigned_member_id).toBe(kid);

    const list = await auth(request.get(`/members/${owner}/products`));
    const row = list.body.items.find((i: any) => i.id === res.body.purchaseId);
    expect(row.assigned_member_id).toBe(kid);
    expect(row.assigned_member_name).toBe('Assignee Kid');
  });

  it('defaults to the purchaser, and reads a legacy row as the purchaser', async () => {
    const res = await auth(request.post(base(loner))).send({ product_id: oneOff, draft: true });
    expect(res.status).toBe(201);
    const { rows } = await db.query<any>(
      'SELECT assigned_member_id FROM member_products_oneoff_snapshot WHERE id = ?', [res.body.purchaseId]);
    expect(rows[0].assigned_member_id).toBe(loner);

    const legacy = await insertTestPurchase(
      `INSERT INTO member_products_oneoff_snapshot
         (gym_id, member_id, product_id, status, product_name, product_type, billing_frequency, amount, currency, created_by)
       VALUES (?, ?, ?, 'active', 'Legacy', 'fee', 'once', 30, 'EUR', 'test')`, [gymId, loner, oneOff]);
    const list = await auth(request.get(`/members/${loner}/products`));
    const row = list.body.items.find((i: any) => i.id === legacy);
    expect(row.assigned_member_id).toBe(loner);
    expect(row.assigned_member_name).toBe('Assignee Loner');
  });

  it('refuses a member outside the family and a garbage id', async () => {
    // A Product of its own: the owner already holds a draft of `oneOff` (first test),
    // which would answer 409 draft_exists before the assignee is judged.
    const fresh = await product(`Towel ${uniq()}`);
    const outside = await auth(request.post(base(owner))).send({ product_id: fresh, draft: true, assigned_member_id: stranger });
    expect(outside.status).toBe(400);
    expect(outside.body.error).toBe('assignee_not_in_family');
    const bad = await auth(request.post(base(owner))).send({ product_id: fresh, draft: true, assigned_member_id: 'x' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('assignee_invalid');
    const { rows } = await db.query<any>(
      'SELECT id FROM member_products_oneoff_snapshot WHERE gym_id = ? AND member_id = ? AND product_id = ?', [gymId, owner, fresh]);
    expect(rows.length).toBe(0); // nothing written for either refusal
  });

  it('stores no assignee for a shared Product (read as the purchaser) and refuses naming one', async () => {
    const ok = await auth(request.post(base(owner))).send({ product_id: shared, draft: true, assigned_member_id: owner });
    expect(ok.status).toBe(201);
    const { rows } = await db.query<any>(
      'SELECT assigned_member_id FROM member_products_oneoff_snapshot WHERE id = ?', [ok.body.purchaseId]);
    expect(rows[0].assigned_member_id).toBeNull();
    const list = await auth(request.get(`/members/${owner}/products`));
    const row = list.body.items.find((i: any) => i.id === ok.body.purchaseId);
    expect(row.assigned_member_id).toBe(owner);
    expect(row.assigned_member_name).toBe('Assignee Owner');

    const refused = await auth(request.post(base(kid))).send({ product_id: shared, draft: true, assigned_member_id: owner });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe('assignee_not_allowed');
  });
});

describe('recurring line', () => {
  it('stores the chosen family member on the Draft line and lists it', async () => {
    const res = await auth(request.post(base(owner))).send({ product_id: monthly, assigned_member_id: kid });
    expect(res.status).toBe(201);
    expect(res.body.kind).toBe('recurring_draft');
    const { rows } = await db.query<any>(
      'SELECT assigned_member_id FROM member_products_recurrent_snapshot WHERE gym_id = ? AND product_set_id = ? AND product_id = ?',
      [gymId, res.body.product_set_id, monthly]);
    expect(rows[0].assigned_member_id).toBe(kid);
    const { rows: mirror } = await db.query<any>(
      'SELECT assigned_member_id FROM product_periodical_snapshots WHERE gym_id = ? AND product_set_id = ? AND product_id = ?',
      [gymId, res.body.product_set_id, monthly]);
    expect(mirror[0].assigned_member_id).toBe(kid);

    const list = await auth(request.get(`/members/${owner}/products`));
    const row = list.body.items.find((i: any) => i.source === 'recurring' && i.product_id === monthly);
    expect(row.assigned_member_id).toBe(kid);
    expect(row.assigned_member_name).toBe('Assignee Kid');

    const outside = await auth(request.post(base(owner))).send({ product_id: monthly, assigned_member_id: stranger });
    expect(outside.status).toBe(400);
    expect(outside.body.error).toBe('assignee_not_in_family');
  });
});
