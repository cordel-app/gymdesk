// #2663 — My Plans and My Products read one Product Set: `GET /me/product-sets/:id`
// reports each plan's status, dates, fee, beneficiaries and included Products from
// that version's own plan snapshot, and a covered family member may read the
// family's committed version, narrowed to what is theirs. Integration.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { verifyToken } from '@clerk/backend';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';
import { activateWithEvents } from '../api/product-set-configuration';

let gymId: string;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}`;
const TODAY = new Date().toISOString().slice(0, 10);

const as = (clerk: string, method: 'get' | 'post', path: string) => {
  vi.mocked(verifyToken).mockResolvedValueOnce({ sub: clerk } as any).mockResolvedValueOnce({ sub: clerk } as any);
  return (request as any)[method](`/me/product-sets${path}`).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
};

async function member(name: string): Promise<{ clerk: string; id: number }> {
  const clerk = `me-psc-${uniq()}`;
  await createTestMembership(gymId, 'member', clerk);
  const { insertId } = await db.query('INSERT INTO members (gym_id, name, email, clerk_user_id) VALUES (?, ?, ?, ?)',
    [gymId, name, `${clerk}@t.com`, clerk]);
  return { clerk, id: insertId };
}

async function product(name: string, sharing: 'individual' | 'shared' = 'individual'): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO products (gym_id, name, type, billing_frequency, status, enrollment_status, currency, amount, tax_behavior, sharing_type)
     VALUES (?, ?, 'fee', 'month', 'active', 'public', 'EUR', '10.00', 'inclusive', ?)`, [gymId, name, sharing]);
  return insertId;
}

async function plan(price: number, includedProductId: number): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, description, lifecycle_status, enrollment_status)
     VALUES (?, ?, 'Gym access', 'active', 'public')`, [gymId, `Plan-${uniq()}`]);
  await db.query(`INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
                  VALUES (?, ?, ?, '2020-01-01', 'active')`, [gymId, insertId, price]);
  await db.query(`INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
                  VALUES (?, ?, 1, 'month')`, [gymId, insertId]);
  await db.query(`INSERT INTO membership_plan_periodical (gym_id, membership_plan_id, product_id, quantity, mandatory)
                  VALUES (?, ?, ?, 2, 1)`, [gymId, insertId, includedProductId]);
  return Number(insertId);
}

beforeAll(async () => { gymId = await createTestGym('Me Product Set Current Gym'); });
afterAll(async () => {
  await db.query('DELETE FROM billing_events WHERE gym_id = ?', [gymId]);
  await cleanupTestGyms();
  await db.end();
});

describe('GET /me/product-sets/:id — My Plans and My Products from one version', () => {
  it("reports a Draft's plans from its own snapshot: status, fee, beneficiaries and included Products", async () => {
    const a = await member('Owner A');
    const towel = await product(`Towel-${uniq()}`);
    const planId = await plan(40, towel);
    const draft = (await as(a.clerk, 'post', '/draft')).body;
    expect((await as(a.clerk, 'post', `/${draft.id}/plans`).send({ membership_plan_id: planId })).status).toBe(200);

    const res = await as(a.clerk, 'get', `/${draft.id}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('draft');
    expect(res.body.plans).toHaveLength(1);
    const p = res.body.plans[0];
    expect(p).toMatchObject({
      membership_plan_id: planId, plan_description: 'Gym access', status: 'draft',
      entitlement_only: false, membership_fee: 40,
    });
    expect(p.beneficiaries).toEqual([expect.objectContaining({ member_id: a.id, name: 'Owner A', is_owner: true })]);
    expect(p.benefits).toEqual([expect.objectContaining({ category: 'periodical', product_id: towel, quantity: 2, mandatory: true })]);
    // #2744 — what the Add Plan catalogue's card draws: the plan's picture and cadence.
    expect(p).toMatchObject({ plan_image_url: null, plan_image_thumbnail_url: null, billing_interval: 1, billing_unit: 'month' });

    // A later catalogue edit moves nothing the version shows.
    await db.query("UPDATE membership_plan_periodical SET quantity = 9 WHERE membership_plan_id = ?", [planId]);
    const again = await as(a.clerk, 'get', `/${draft.id}`);
    expect(again.body.plans[0].benefits[0].quantity).toBe(2);
  });

  it("lets a covered family member read the family's Active version, narrowed to what is theirs", async () => {
    const a = await member('Owner B');
    const b = await member('Kid B');
    const outsider = await member('Outsider');
    const towel = await product(`Towel-${uniq()}`);
    const planId = await plan(30, towel);
    const shared = await product(`Family-${uniq()}`, 'shared');
    const ownerOnly = await product(`Locker-${uniq()}`);

    const draft = (await as(a.clerk, 'post', '/draft')).body;
    expect((await as(a.clerk, 'post', `/${draft.id}/plans`).send({ membership_plan_id: planId })).status).toBe(200);
    expect((await as(a.clerk, 'post', `/${draft.id}/services`).send({ product_id: shared })).status).toBe(200);
    expect((await as(a.clerk, 'post', `/${draft.id}/services`).send({ product_id: ownerOnly })).status).toBe(200);

    // While it is a Draft it stays the owner's.
    expect((await as(b.clerk, 'get', `/${draft.id}`)).status).toBe(404);

    await db.transaction((tx) => activateWithEvents(tx, { gymId, productSetId: draft.id, today: TODAY }));
    const { rows: snaps } = await db.query<any>(
      'SELECT plan_snapshot_id FROM product_set_plan_snapshots WHERE product_set_id = ?', [draft.id]);
    await db.query('INSERT INTO plan_snapshot_beneficiaries (gym_id, plan_snapshot_id, member_id, is_owner) VALUES (?, ?, ?, 0)',
      [gymId, snaps[0].plan_snapshot_id, b.id]);

    const owner = await as(a.clerk, 'get', `/${draft.id}`);
    expect(owner.status).toBe(200);
    expect(owner.body.status).toBe('active');
    expect(owner.body.plans[0].status).toBe('active');
    expect(owner.body.lines.map((l: any) => l.product_id).sort()).toEqual([shared, ownerOnly].sort());

    const list = await as(b.clerk, 'get', '');
    expect(list.body).toEqual(expect.arrayContaining([expect.objectContaining({ id: draft.id, own: false })]));

    const kid = await as(b.clerk, 'get', `/${draft.id}`);
    expect(kid.status).toBe(200);
    expect(kid.body.plans).toHaveLength(1);
    expect(kid.body.plans[0].beneficiaries.map((x: any) => x.member_id)).toEqual(expect.arrayContaining([a.id, b.id]));
    // The family's shared Product, never the owner's individual one.
    expect(kid.body.lines.map((l: any) => l.product_id)).toEqual([shared]);
    expect(kid.body.removed_lines).toEqual([]);

    expect((await as(outsider.clerk, 'get', `/${draft.id}`)).status).toBe(404);
  });

  it('marks the owner\'s own versions as own', async () => {
    const a = await member('Owner C');
    const draft = (await as(a.clerk, 'post', '/draft')).body;
    const list = await as(a.clerk, 'get', '');
    expect(list.body).toEqual([expect.objectContaining({ id: draft.id, status: 'draft', own: true })]);
  });
});
