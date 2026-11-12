// #2496 stage 5 — the member's own Save & Pay of their Draft Product Set
// (`POST /me/product-sets/:id/save-and-pay` and `/activate`). Integration: the
// Admin's handlers behind the member's own ownership check; the amount charged
// is the one the review quoted, and a second submission charges nothing.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Only the call that would reach Monei is stubbed.
vi.mock('../payments', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../payments')>();
  return {
    ...mod,
    getPaymentProvider: () => {
      const real = mod.getPaymentProvider();
      return Object.assign(Object.create(real), {
        createPaymentRequest: async (p: { orderId: string }) => ({
          providerOrderId: `monei-${p.orderId}`, checkoutUrl: 'https://pay.test/x',
        }),
      });
    },
  };
});

import { verifyToken } from '@clerk/backend';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';

let gymId: string;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}`;

const as = (clerk: string, method: 'get' | 'post' | 'delete', path: string) => {
  // `/me` (meRouter) authenticates first, then falls through to this router: two verifications.
  vi.mocked(verifyToken).mockResolvedValueOnce({ sub: clerk } as any).mockResolvedValueOnce({ sub: clerk } as any);
  return (request as any)[method](`/me/product-sets${path}`).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
};

async function member(): Promise<{ clerk: string; id: number }> {
  const clerk = `me-psc-${uniq()}`;
  await createTestMembership(gymId, 'member', clerk);
  const { insertId } = await db.query('INSERT INTO members (gym_id, name, email, clerk_user_id) VALUES (?, ?, ?, ?)',
    [gymId, 'M', `${clerk}@t.com`, clerk]);
  return { clerk, id: insertId };
}

async function product(amount: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO products (gym_id, name, type, billing_frequency, status, enrollment_status, currency, amount, tax_behavior)
     VALUES (?, ?, 'fee', 'month', 'active', 'public', 'EUR', ?, 'inclusive')`, [gymId, `Locker-${uniq()}`, amount]);
  return insertId;
}

async function draftWith(m: { clerk: string }, amount: string): Promise<number> {
  const draft = (await as(m.clerk, 'post', '/draft')).body;
  const add = await as(m.clerk, 'post', `/${draft.id}/services`).send({ product_id: await product(amount) });
  expect(add.status).toBe(200);
  return Number(draft.id);
}

const count = async (sql: string, params: unknown[]) => Number((await db.query<any>(sql, params)).rows[0].n);

beforeAll(async () => {
  process.env.MONEI_API_KEY = 'test-api-key';
  process.env.MONEI_WEBHOOK_SECRET = 'test-me-commit';
  gymId = await createTestGym('Me Product Set Commit Gym');
});
afterAll(async () => {
  delete process.env.MONEI_API_KEY;
  delete process.env.MONEI_WEBHOOK_SECRET;
  await db.query('DELETE FROM payment_requests WHERE gym_id = ?', [gymId]);
  await db.query('DELETE FROM billing_events WHERE gym_id = ?', [gymId]);
  await cleanupTestGyms();
  await db.end();
});

describe('POST /me/product-sets/:id/save-and-pay', () => {
  it('charges the reviewed amount once, through one checkout, and refuses a second submission', async () => {
    const m = await member();
    const id = await draftWith(m, '10.00');

    const review = await as(m.clerk, 'get', `/${id}/review`);
    expect(review.status).toBe(200);
    expect(review.body.payment_required).toBe(true);
    // Nothing is written before the member confirms.
    expect(await count('SELECT COUNT(*) AS n FROM billing_events WHERE product_set_id = ?', [id])).toBe(0);

    const pay = await as(m.clerk, 'post', `/${id}/save-and-pay`).send({});
    expect(pay.status).toBe(201);
    expect(pay.body).toMatchObject({ product_set_id: id, status: 'pending_payment' });
    expect(pay.body.amount).toBe(review.body.amount_due);
    expect(typeof pay.body.checkout_url).toBe('string');

    const { rows } = await db.query<any>('SELECT status FROM product_sets WHERE id = ?', [id]);
    expect(rows[0].status).toBe('pending_payment');
    const { rows: ev } = await db.query<any>(
      `SELECT amount FROM billing_events WHERE product_set_id = ? AND event_type = 'payment_recorded'`, [id]);
    expect(ev).toHaveLength(1);
    expect(Number(ev[0].amount)).toBe(review.body.amount_due);

    const again = await as(m.clerk, 'post', `/${id}/save-and-pay`).send({});
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('not_committable');
    expect(await count(
      `SELECT COUNT(*) AS n FROM payment_requests pr JOIN billing_events be ON be.id = pr.billing_event_id
        WHERE be.product_set_id = ?`, [id])).toBe(1);
  });

  it('answers nothing_to_pay for a Draft that owes nothing, which activates instead', async () => {
    const m = await member();
    const id = await draftWith(m, '0.00');

    const pay = await as(m.clerk, 'post', `/${id}/save-and-pay`).send({});
    expect(pay.status).toBe(409);
    expect(pay.body.error).toBe('nothing_to_pay');

    const act = await as(m.clerk, 'post', `/${id}/activate`).send({});
    expect(act.status).toBe(200);
    expect(act.body).toMatchObject({ product_set_id: id, status: 'active' });
    expect(await count('SELECT COUNT(*) AS n FROM payment_requests pr JOIN billing_events be ON be.id = pr.billing_event_id WHERE be.product_set_id = ?', [id])).toBe(0);

    // Activating a priced Draft is refused: it must be paid.
    const priced = await draftWith(m, '10.00');
    const refused = await as(m.clerk, 'post', `/${priced}/activate`).send({});
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('payment_required');
  });

  it("does not let a member commit another member's Draft", async () => {
    const owner = await member();
    const other = await member();
    const id = await draftWith(owner, '10.00');

    expect((await as(other.clerk, 'post', `/${id}/save-and-pay`).send({})).status).toBe(404);
    expect((await as(other.clerk, 'post', `/${id}/activate`).send({})).status).toBe(404);
    const { rows } = await db.query<any>('SELECT status FROM product_sets WHERE id = ?', [id]);
    expect(rows[0].status).toBe('draft');
    expect(await count('SELECT COUNT(*) AS n FROM billing_events WHERE product_set_id = ?', [id])).toBe(0);
  });

  it('requires a signed-in caller', async () => {
    const res = await (request as any).post('/me/product-sets/1/save-and-pay').set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });
});
