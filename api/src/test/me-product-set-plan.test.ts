// #2496 stage 4 — Add Plan on the member's shared Draft (`/me/product-sets/:id/plans`).
// Integration: the member's first plan joins the Draft their Products are on, judged by the
// immediate purchase's own checks; one Draft is one purchase, and nothing is charged.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { verifyToken } from '@clerk/backend';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';
import { activateWithEvents } from '../api/product-set-configuration';

let gymId: string;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}`;
const TODAY = new Date().toISOString().slice(0, 10);

const as = (clerk: string, method: 'get' | 'post' | 'put' | 'delete', path: string, gid = gymId) => {
  // `/me` (meRouter) authenticates first, then falls through to this router: two verifications.
  vi.mocked(verifyToken).mockResolvedValueOnce({ sub: clerk } as any).mockResolvedValueOnce({ sub: clerk } as any);
  return (request as any)[method](`/me/product-sets${path}`).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gid);
};

async function member(): Promise<{ clerk: string; id: number }> {
  const clerk = `me-psp-${uniq()}`;
  await createTestMembership(gymId, 'member', clerk);
  const { insertId } = await db.query('INSERT INTO members (gym_id, name, email, clerk_user_id) VALUES (?, ?, ?, ?)',
    [gymId, 'M', `${clerk}@t.com`, clerk]);
  return { clerk, id: insertId };
}

async function product(name: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO products (gym_id, name, type, billing_frequency, status, enrollment_status, currency, amount, tax_behavior)
     VALUES (?, ?, 'fee', 'month', 'active', 'public', 'EUR', '10.00', 'inclusive')`, [gymId, name]);
  return insertId;
}

async function plan(price: number, over: { enrollment?: string; optional?: number; mandatory?: number } = {}): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status)
     VALUES (?, ?, 'active', ?)`, [gymId, `Plan-${uniq()}`, over.enrollment ?? 'public']);
  await db.query(`INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
                  VALUES (?, ?, ?, '2020-01-01', 'active')`, [gymId, insertId, price]);
  await db.query(`INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
                  VALUES (?, ?, 1, 'month')`, [gymId, insertId]);
  for (const [pid, mandatory] of [[over.optional, 0], [over.mandatory, 1]] as const) {
    if (pid == null) continue;
    await db.query(`INSERT INTO membership_plan_periodical (gym_id, membership_plan_id, product_id, quantity, mandatory)
                    VALUES (?, ?, ?, 1, ?)`, [gymId, insertId, pid, mandatory]);
  }
  return Number(insertId);
}

beforeAll(async () => { gymId = await createTestGym('Me Product Set Plan Gym'); });
afterAll(async () => {
  await db.query('DELETE FROM billing_events WHERE gym_id = ?', [gymId]);
  await cleanupTestGyms();
  await db.end();
});

describe('POST /me/product-sets/:id/plans', () => {
  it('puts the plan on the same Draft as the Products, and commits as one version', async () => {
    const m = await member();
    const draft = (await as(m.clerk, 'post', '/draft')).body;
    const locker = await product(`Locker-${uniq()}`);
    expect((await as(m.clerk, 'post', `/${draft.id}/services`).send({ product_id: locker })).status).toBe(200);
    const planId = await plan(40);

    const add = await as(m.clerk, 'post', `/${draft.id}/plans`).send({ membership_plan_id: planId });
    expect(add.status).toBe(200);
    expect(add.body.product_set_id).toBe(draft.id);

    const view = await as(m.clerk, 'get', `/${draft.id}`);
    expect(view.status).toBe(200);
    expect(view.body.membership_plan_id).toBe(planId);
    expect(view.body.plans).toHaveLength(1);
    expect(view.body.plans[0]).toMatchObject({ membership_plan_id: planId, change: 'added' });
    expect(view.body.lines.map((l: any) => l.product_id)).toEqual([locker]);

    // Still one in-flight version for the member, and nothing billed yet.
    const { rows: sets } = await db.query<any>(
      `SELECT COUNT(*) AS n FROM product_sets WHERE gym_id = ? AND owner_member_id = ? AND status = 'draft'`, [gymId, m.id]);
    expect(Number(sets[0].n)).toBe(1);
    const { rows: events } = await db.query<any>('SELECT COUNT(*) AS n FROM billing_events WHERE product_set_id = ?', [draft.id]);
    expect(Number(events[0].n)).toBe(0);

    // Committing the Draft activates the plan and the Product together.
    await db.transaction((tx) => activateWithEvents(tx, { gymId, productSetId: draft.id, today: TODAY }));
    const { rows: um } = await db.query<any>(
      `SELECT um.status FROM user_memberships um JOIN product_sets ps ON ps.user_membership_id = um.id
        WHERE ps.id = ?`, [draft.id]);
    expect(um[0]?.status).toBe('active');
    const { rows: lines } = await db.query<any>(
      `SELECT bl.kind FROM billing_events be JOIN billing_event_lines bl ON bl.billing_event_id = be.id
        WHERE be.product_set_id = ? AND be.is_scheduled = 1`, [draft.id]);
    const kinds = new Set(lines.map((l: any) => l.kind));
    expect(kinds.has('membership_fee')).toBe(true);
    expect(lines.length).toBeGreaterThan(1);
  });

  it('keeps a declined optional Product off the plan and refuses declining a mandatory one', async () => {
    const m = await member();
    const draft = (await as(m.clerk, 'post', '/draft')).body;
    const towel = await product(`Towel-${uniq()}`);
    const insurance = await product(`Insurance-${uniq()}`);
    const planId = await plan(30, { optional: towel, mandatory: insurance });

    const refused = await as(m.clerk, 'post', `/${draft.id}/plans`)
      .send({ membership_plan_id: planId, declined_benefits: [{ section: 'periodical', product_id: insurance }] });
    expect(refused.status).toBe(400);

    const ok = await as(m.clerk, 'post', `/${draft.id}/plans`)
      .send({ membership_plan_id: planId, declined_benefits: [{ section: 'periodical', product_id: towel }] });
    expect(ok.status).toBe(200);
    const { rows } = await db.query<any>(
      'SELECT product_id FROM plan_periodical_snapshots WHERE plan_snapshot_id = ?', [ok.body.plan_snapshot_id]);
    expect(rows.map((r: any) => Number(r.product_id))).toEqual([insurance]);
  });

  it('refuses a second plan on the Draft, a plan not offered to members, and a member who holds a plan', async () => {
    const m = await member();
    const draft = (await as(m.clerk, 'post', '/draft')).body;
    const hidden = await plan(25, { enrollment: 'staff_only' });
    expect((await as(m.clerk, 'post', `/${draft.id}/plans`).send({ membership_plan_id: hidden })).status).toBe(400);

    const first = await plan(25);
    expect((await as(m.clerk, 'post', `/${draft.id}/plans`).send({ membership_plan_id: first })).status).toBe(200);
    const second = await as(m.clerk, 'post', `/${draft.id}/plans`).send({ membership_plan_id: await plan(26) });
    expect(second.status).toBe(409);
    expect(second.body.error).toBe('draft_has_plan');

    // Once committed the member holds a plan: a new Draft never takes another one (#1288 §28).
    await db.transaction((tx) => activateWithEvents(tx, { gymId, productSetId: draft.id, today: TODAY }));
    const next = (await as(m.clerk, 'post', '/draft')).body;
    const held = await as(m.clerk, 'post', `/${next.id}/plans`).send({ membership_plan_id: await plan(27) });
    expect(held.status).toBe(409);
    expect(held.body.error).toBe('plan_change_via_gym');
    // The plan the member holds reads as inherited and cannot be removed from the Draft.
    const view = (await as(m.clerk, 'get', `/${next.id}`)).body;
    expect(view.plans).toHaveLength(1);
    expect(view.plans[0].change).toBe('inherited');
    const remove = await as(m.clerk, 'delete', `/${next.id}/plans/${view.plans[0].plan_snapshot_id}`);
    expect(remove.status).toBe(409);
    expect(remove.body.error).toBe('plan_not_removable');
  });

  it('removes the plan the Draft added and keeps its Products', async () => {
    const m = await member();
    const draft = (await as(m.clerk, 'post', '/draft')).body;
    const locker = await product(`Locker-${uniq()}`);
    await as(m.clerk, 'post', `/${draft.id}/services`).send({ product_id: locker });
    const added = await as(m.clerk, 'post', `/${draft.id}/plans`).send({ membership_plan_id: await plan(20) });
    expect(added.status).toBe(200);

    const removed = await as(m.clerk, 'delete', `/${draft.id}/plans/${added.body.plan_snapshot_id}`);
    expect(removed.status).toBe(200);
    const view = (await as(m.clerk, 'get', `/${draft.id}`)).body;
    expect(view.plans).toEqual([]);
    expect(view.membership_plan_id).toBeNull();
    expect(view.lines.map((l: any) => l.product_id)).toEqual([locker]);
    const { rows } = await db.query<any>('SELECT COUNT(*) AS n FROM plan_snapshots WHERE id = ?', [added.body.plan_snapshot_id]);
    expect(Number(rows[0].n)).toBe(0);

    // The selection can take a plan again.
    expect((await as(m.clerk, 'post', `/${draft.id}/plans`).send({ membership_plan_id: await plan(21) })).status).toBe(200);
  });

  it("another member cannot add a plan to someone else's Draft", async () => {
    const a = await member();
    const b = await member();
    const draft = (await as(a.clerk, 'post', '/draft')).body;
    const res = await as(b.clerk, 'post', `/${draft.id}/plans`).send({ membership_plan_id: await plan(10) });
    expect(res.status).toBe(404);
  });

  it('400 for a missing plan id', async () => {
    const m = await member();
    const draft = (await as(m.clerk, 'post', '/draft')).body;
    expect((await as(m.clerk, 'post', `/${draft.id}/plans`).send({})).status).toBe(400);
  });
});
