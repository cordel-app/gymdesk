// #2126 stage 2: the Product snapshot tables follow every write of a Draft's recurring lines (since
// stage 5d-6 they are the only tables a line lives in).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER, activateTestAssignment, cleanupTestGyms, createTestDraftAssignment, createTestGym,
  createTestMembership, request,
} from './helpers';

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

let gymId: string;
let owner: number;
let productId: number;
let umId: number;
let setId: number;

const auth = (r: any) => r.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
const lines = async (set: number) =>
  (await db.query<any>(
    // The lines `set` wrote: since #2126 stage 6b a line names no set, and its writer is the first set linking it.
    `SELECT s.* FROM product_periodical_snapshots s
      WHERE s.gym_id = ? AND (SELECT MIN(lk.product_set_id) FROM product_set_periodical_snapshots lk
                               WHERE lk.product_periodical_snapshot_id = s.id) = ?`, [gymId, set])).rows;

beforeAll(async () => {
  gymId = await createTestGym('Product Dual Write Gym');
  await createTestMembership(gymId, 'admin');
  owner = (await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)', [gymId, 'Owner', `pdw-${uniq()}@test.com`])).insertId as number;
  const planId = (await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, ?, 'active', 'staff_only', '1')`, [gymId, `PDW-Plan-${uniq()}`])).insertId as number;
  productId = (await db.query(
    `INSERT INTO products (gym_id, name, type, billing_frequency, amount, status, is_system, currency)
     VALUES (?, ?, 'service', 'month', 20.00, 'active', 0, 'EUR')`, [gymId, `PDW-Prod-${uniq()}`])).insertId as number;
  umId = await createTestDraftAssignment(gymId, owner, planId, { config: { membership_fee_price: 0 } as any });
  setId = (await db.query<any>('SELECT id FROM product_sets WHERE user_membership_id = ?', [umId])).rows[0].id;
});

describe('recurring Product lines follow the Draft (#2126 stage 2)', () => {
  let lineId: number;

  it('adding, re-quantifying and removing a line is mirrored', async () => {
    const add = await auth(request.post(`/product-sets/${setId}/services`)).send({ product_id: productId, quantity: 1 });
    expect(add.status).toBeLessThan(300);
    let rows = await lines(setId);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('draft');
    expect(rows[0].member_id).toBe(owner);
    lineId = rows[0].source_id;

    const qty = await auth(request.put(`/product-sets/${setId}/services/${lineId}`)).send({ quantity: 3 });
    expect(qty.status).toBeLessThan(300);
    expect((await lines(setId))[0].quantity).toBe(3);

    const del = await auth(request.delete(`/product-sets/${setId}/services/${lineId}`));
    expect(del.status).toBeLessThan(300);
    expect(await lines(setId)).toHaveLength(0);
  });

  it('committing makes the line active and a successor links the same line (#2126 stage 5c-2c-2)', async () => {
    const add = await auth(request.post(`/product-sets/${setId}/services`)).send({ product_id: productId, quantity: 2 });
    expect(add.status).toBeLessThan(300);
    await activateTestAssignment(gymId, umId);
    expect((await lines(setId))[0].status).toBe('active');

    const draft = await auth(request.post('/product-sets/draft')).send({ member_id: owner });
    expect(draft.status).toBeLessThan(300);
    const newSet = Number(draft.body.product_set_id ?? draft.body.id);
    // No copy: the Draft links the active set's own line, which keeps the active set's status.
    expect(await lines(newSet)).toHaveLength(0);
    const { rows: linked } = await db.query<any>(
      `SELECT s.* FROM product_set_periodical_snapshots lnk
         JOIN product_periodical_snapshots s ON s.id = lnk.product_periodical_snapshot_id
        WHERE lnk.product_set_id = ?`, [newSet]);
    expect(linked).toHaveLength(1);
    expect(linked[0].id).toBe((await lines(setId))[0].id);
    expect(linked[0].status).toBe('active');
    expect(linked[0].quantity).toBe(2);
  });
});
