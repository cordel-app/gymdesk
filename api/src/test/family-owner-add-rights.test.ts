// #2770: in a Family only the Family Owner adds Membership Plans and Products from the
// Members App. Every add route refuses another family member (403 family_owner_only),
// `GET /me/membership` reports the flag the app hides the buttons with, and a member
// who is alone in their family (its owner) or in none keeps adding as before.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { verifyToken } from '@clerk/backend';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';

let gymId: string;
const stamp = Date.now();
const OWNER = `fam-add-owner-${stamp}`;
const OTHER = `fam-add-other-${stamp}`;
const SOLO = `fam-add-solo-${stamp}`;
let owner: number;
let other: number;
let productId: number;
let oneOffId: number;
let planId: number;

function as(clerk: string) {
  vi.mocked(verifyToken).mockResolvedValue({ sub: clerk } as any);
  const auth = (r: any) => r.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
  return {
    get: (path: string) => auth(request.get(path)),
    post: (path: string) => auth(request.post(path)),
  };
}

async function member(name: string, clerk: string): Promise<number> {
  await createTestMembership(gymId, 'member', clerk);
  const { insertId } = await db.query(
    'INSERT INTO members (gym_id, name, email, clerk_user_id) VALUES (?, ?, ?, ?)',
    [gymId, name, `${clerk}@test.com`, clerk]);
  return insertId as number;
}

beforeAll(async () => {
  gymId = await createTestGym('Family Owner Add Rights Gym');
  owner = await member('Owner', OWNER);
  other = await member('Other', OTHER);
  await member('Solo', SOLO);

  const p = await db.query(
    `INSERT INTO products (gym_id, name, type, billing_frequency, status, enrollment_status, currency, amount, tax_behavior)
     VALUES (?, 'Locker', 'fee', 'month', 'active', 'public', 'EUR', '10.00', 'inclusive')`, [gymId]);
  productId = p.insertId;
  const o = await db.query(
    `INSERT INTO products (gym_id, name, type, billing_frequency, status, enrollment_status, currency, amount, tax_behavior)
     VALUES (?, 'Towel', 'fee', 'once', 'active', 'public', 'EUR', '5.00', 'inclusive')`, [gymId]);
  oneOffId = o.insertId;
  const pl = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status) VALUES (?, 'Basic', 'active', 'public')`,
    [gymId]);
  planId = pl.insertId;
});

afterAll(async () => { await cleanupTestGyms(); await db.end(); });

describe('Family Owner add rights (#2770)', () => {
  let otherDraftId: number;

  it('a member who is not yet in a family may add (no family row reads as their own)', async () => {
    const me = await as(OTHER).get('/me/membership');
    expect(me.status).toBe(200);
    expect(me.body.can_add_plans_and_products).toBe(true);
    // The Draft the member opened before joining a family: it is still theirs.
    const draft = await as(OTHER).post('/me/product-sets/draft');
    expect(draft.status).toBe(201);
    otherDraftId = draft.body.id;

    const { insertId: familyId } = await db.query('INSERT INTO families (gym_id, name) VALUES (?, ?)', [gymId, 'F']);
    await db.query('INSERT INTO family_members (gym_id, family_id, member_id, is_owner) VALUES (?, ?, ?, 1)', [gymId, familyId, owner]);
    await db.query('INSERT INTO family_members (gym_id, family_id, member_id, is_owner) VALUES (?, ?, ?, 0)', [gymId, familyId, other]);
  });

  it('reports the flag: true for the Family Owner, false for another family member', async () => {
    expect((await as(OWNER).get('/me/membership')).body.can_add_plans_and_products).toBe(true);
    expect((await as(OTHER).get('/me/membership')).body.can_add_plans_and_products).toBe(false);
  });

  it('refuses every add route to a family member who is not the owner', async () => {
    const calls = [
      as(OTHER).post('/me/product-sets/draft'),
      as(OTHER).post(`/me/product-sets/${otherDraftId}/services`).send({ product_id: productId }),
      as(OTHER).post(`/me/product-sets/${otherDraftId}/plans`).send({ membership_plan_id: planId }),
      as(OTHER).post(`/me/product-sets/${otherDraftId}/purchases`).send({ product_id: oneOffId }),
      as(OTHER).post(`/me/membership-plans/${planId}/assign`).send({}),
      as(OTHER).post(`/me/products/${oneOffId}/purchase`).send({}),
    ];
    for (const call of calls) {
      const res = await call;
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('family_owner_only');
    }
    // Nothing was added to the Draft and no purchase was written.
    const { rows } = await db.query<any>(
      `SELECT COUNT(*) AS n FROM product_set_periodical_snapshots WHERE product_set_id = ?`, [otherDraftId]);
    expect(Number(rows[0].n)).toBe(0);
    const { rows: pr } = await db.query<any>('SELECT COUNT(*) AS n FROM payment_requests WHERE gym_id = ?', [gymId]);
    expect(Number(pr[0].n)).toBe(0);
  });

  it('lets the Family Owner add a Product to their Draft', async () => {
    const draft = await as(OWNER).post('/me/product-sets/draft');
    expect(draft.status).toBe(201);
    const add = await as(OWNER).post(`/me/product-sets/${draft.body.id}/services`).send({ product_id: productId });
    expect(add.status).toBe(200);
  });

  it('a member alone in their own family is its owner and keeps adding', async () => {
    const soloId = (await db.query<any>('SELECT id FROM members WHERE gym_id = ? AND clerk_user_id = ?', [gymId, SOLO])).rows[0].id;
    const { insertId: familyId } = await db.query('INSERT INTO families (gym_id, name) VALUES (?, ?)', [gymId, 'Solo']);
    await db.query('INSERT INTO family_members (gym_id, family_id, member_id, is_owner) VALUES (?, ?, ?, 1)', [gymId, familyId, soloId]);
    expect((await as(SOLO).get('/me/membership')).body.can_add_plans_and_products).toBe(true);
    expect((await as(SOLO).post('/me/product-sets/draft')).status).toBe(201);
  });
});
