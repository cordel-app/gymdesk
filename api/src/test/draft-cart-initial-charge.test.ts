// #2899 — a Draft's initial payment and its Billing Event simulation are derived from the
// Draft's current contents. A Draft that adds a Membership Plan beside one the member already
// holds owes the added plan's fee (here: two beneficiaries × two pre-paid months, plus the
// stretch that aligns it to the running schedule), and never the running plan's fee again. The
// review the cart and Save & Pay read and the Draft's forecast quote the same figure, and
// reading them commits nothing.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { productSetOfLegacyAssignmentSql, productSetLegacyAssignmentIdSql } from '../domain/planAssignments';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER, activateTestAssignment, cleanupTestGyms, createTestFamily, createTestGym, createTestMembership, request,
} from './helpers';
import { legacyProductInsert } from './legacyProductFixture';

const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const today = () => new Date().toISOString().slice(0, 10);
let gymId: string;

beforeAll(async () => {
  gymId = await createTestGym();
  await createTestMembership(gymId, 'admin');
});
afterAll(async () => {
  await db.query('DELETE FROM payment_requests WHERE gym_id = ?', [gymId]);
  await db.query('DELETE FROM billing_events WHERE gym_id = ?', [gymId]);
  await cleanupTestGyms();
  await db.end();
});

/** A monthly, per-member plan for two members, with two pre-paid periods. */
async function plan(price: number, prepaid: number): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit,
        free_periods, paid_periods, bonus_periods, pay_beforehand_periods, membership_fee_scope)
     VALUES (?, ?, 'active', 'public', '2', 0, 12, 0, ?, 'per_member')`, [gymId, `Draft Cart Plan ${uniq()}`, prepaid]);
  await db.query(`INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
     VALUES (?, ?, ?, '2025-01-01', 'active')`, [gymId, insertId, price]);
  await db.query(`INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
     VALUES (?, ?, 1, 'month')`, [gymId, insertId]);
  return insertId;
}

async function member(): Promise<number> {
  const { insertId } = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, 'Draft Cart Member', `dcart-${uniq()}@t.com`]);
  return insertId;
}

const staff = (method: 'get' | 'post', path: string) =>
  (request as any)[method](path).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);

const dayFromToday = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

async function assign(planId: number, owner: number, beneficiaries: number[], startsAt = today()): Promise<number> {
  const res = await staff('post', `/membership-plans/${planId}/assign`)
    .send({ starts_at: startsAt, owner_member_id: owner, beneficiary_member_ids: beneficiaries });
  expect(res.status).toBe(201);
  return Number(res.body.id);
}

async function setOf(userMembershipId: number) {
  const { rows } = await db.query<any>(
    `SELECT id, status, previous_product_set_id FROM product_sets WHERE ${productSetOfLegacyAssignmentSql('?', 'product_sets')} ORDER BY id DESC LIMIT 1`,
    [userMembershipId]);
  return rows[0];
}

/** A family of two holding a running €30 per-member plan. */
async function familyWithRunningPlan() {
  const owner = await member();
  const kid = await member();
  await createTestFamily(gymId, owner, [kid]);
  const running = await plan(30, 0);
  await activateTestAssignment(gymId, await assign(running, owner, [owner, kid]));
  return { owner, kid, runningName: await planName(running) };
}

const planName = async (id: number) => String((await db.query<any>('SELECT name FROM membership_plans WHERE id = ?', [id])).rows[0].name);

describe('Draft initial payment and simulation (#2899)', () => {
  it('charges the fee of a plan the Draft adds beside a running one, and the forecast agrees', async () => {
    const { owner, kid, runningName } = await familyWithRunningPlan();
    const added = await plan(70, 2);
    const set = await setOf(await assign(added, owner, [owner, kid]));
    expect(set.status).toBe('in_cart');
    expect(set.previous_product_set_id).not.toBeNull();

    const review = await staff('get', `/product-sets/${set.id}/review`);
    expect(review.status).toBe(200);
    // The added plan's fee alone: the running €30 plan was paid by the version it supersedes.
    // #3440 stage 2: when the plan joins the running schedule mid-period, its prorated stretch and
    // its prepayment are two lines of the same fee; otherwise the fee is one line.
    const addedName = await planName(added);
    expect(review.body.immediate_lines.length).toBeGreaterThanOrEqual(1);
    expect(review.body.immediate_lines.length).toBeLessThanOrEqual(2);
    expect(review.body.immediate_lines.every((l: any) => l.item_name === addedName && l.quantity === 2)).toBe(true);
    expect(review.body.immediate_lines.filter((l: any) => l.prepaid_periods === 2)).toHaveLength(1);
    expect(review.body.immediate_lines.some((l: any) => l.item_name === runningName)).toBe(false);
    // Two members × two pre-paid €70 months, plus any stretch up to the running schedule's next date.
    expect(review.body.amount_due).toBeGreaterThanOrEqual(280);

    const sim = await staff('get', `/product-sets/${set.id}/billing-event-simulation`);
    expect(sim.status).toBe(200);
    const initial = sim.body.dates.find((d: any) => d.kind === 'initial_payment');
    expect(initial?.total).toBe(review.body.amount_due);

    // Reading the review and the forecast commits and charges nothing.
    expect((await setOf((await db.query<any>(`SELECT ${productSetLegacyAssignmentIdSql('product_sets')} AS user_membership_id FROM product_sets WHERE id = ?`, [set.id])).rows[0].user_membership_id)).status).toBe('in_cart');
    const { rows } = await db.query<any>('SELECT COUNT(*) AS n FROM billing_events WHERE product_set_id = ?', [set.id]);
    expect(Number(rows[0].n)).toBe(0);
  });

  it('does not ask again for the running plan when a Draft adds no plan', async () => {
    const { owner, runningName } = await familyWithRunningPlan();
    const draft = await staff('post', '/product-sets/draft').send({ member_id: owner });
    expect([200, 201]).toContain(draft.status);

    const review = await staff('get', `/product-sets/${draft.body.id}/review`);
    expect(review.status).toBe(200);
    expect(review.body.immediate_lines.some((l: any) => l.item_name === runningName)).toBe(false);
    expect(review.body.amount_due).toBe(0);
  });

  // #3031 — the simulation lists what the current cart carries and nothing else: a pending
  // purchase left behind by an earlier, cancelled draft is not part of it.
  it('leaves a stale purchase of another draft out of the simulation', async () => {
    const { owner } = await familyWithRunningPlan();
    const draft = await staff('post', '/product-sets/draft').send({ member_id: owner });
    expect([200, 201]).toContain(draft.status);
    await legacyProductInsert(`INSERT INTO member_products_oneoff_snapshot
         (gym_id, member_id, status, product_name, product_type, amount, currency)
       VALUES (?, ?, 'pending_payment', 'Stale Locker 3031', 'fee', 15.00, 'EUR')`, [gymId, owner]);

    const sim = await staff('get', `/product-sets/${draft.body.id}/billing-event-simulation`);
    expect(sim.status).toBe(200);
    const labels = sim.body.dates.flatMap((d: any) => d.lines.map((l: any) => l.label));
    expect(labels).not.toContain('Stale Locker 3031');
  });

  // #3441 — the plan the Draft adds owes its first cycle at Save & Pay whatever day it starts on, as
  // a first version does: a plan starting next week, or back-dated last week, used to read "Nothing
  // is due today" in the Summary and the Save & Pay modal alike. Its paid first cycle is then not
  // persisted as an obligation too.
  for (const [label, offset] of [['starts in the future', 10], ['started in the past', -5]] as const) {
    it(`charges the added plan's first cycle when it ${label}, and never again as an obligation`, async () => {
      const { owner, kid } = await familyWithRunningPlan();
      const added = await plan(70, 0);
      const set = await setOf(await assign(added, owner, [owner, kid], dayFromToday(offset)));
      expect(set.previous_product_set_id).not.toBeNull();

      const review = await staff('get', `/product-sets/${set.id}/review`);
      expect(review.status).toBe(200);
      expect(review.body.amount_due).toBeGreaterThan(0);
      expect(review.body.initial_payment.total).toBe(review.body.amount_due);
      expect(review.body.initial_payment.lines.map((l: any) => l.name)).toEqual([await planName(added)]);

      const sim = await staff('get', `/product-sets/${set.id}/billing-event-simulation`);
      const initial = sim.body.dates.find((d: any) => d.kind === 'initial_payment');
      expect(initial?.total).toBe(review.body.amount_due);

      const pay = await staff('post', `/product-sets/${set.id}/pay`).send({ method: 'cash' });
      expect(pay.status).toBe(201);
      expect(pay.body.amount).toBe(review.body.amount_due);
      const { rows } = await db.query<any>(
        `SELECT be.billing_date FROM billing_events be
          WHERE be.product_set_id = ? AND be.event_type = 'charge_created' AND be.billing_date <= ?`,
        [set.id, dayFromToday(Math.max(offset, 0))]);
      expect(rows).toEqual([]);
    });
  }
});
