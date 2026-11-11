// #2496 stage 1 — the member's own Draft Product Set (`/me/product-sets`).
// Integration: the member is the session's, the Draft is built through the Admin's
// writers, only catalogue Products may be added, and nothing is charged.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { verifyToken } from '@clerk/backend';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';

let gymId: string;
const A = `me-psd-a-${Date.now()}`;
const B = `me-psd-b-${Date.now()}`;
let memberA: number;

const as = (clerk: string, method: 'get' | 'post' | 'put' | 'delete', path: string, gid = gymId) => {
  // `/me` (meRouter) authenticates first, then falls through to this router: two verifications.
  vi.mocked(verifyToken).mockResolvedValueOnce({ sub: clerk } as any).mockResolvedValueOnce({ sub: clerk } as any);
  return (request as any)[method](`/me/product-sets${path}`).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gid);
};

async function product(name: string, over: Record<string, unknown> = {}): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO products (gym_id, name, type, billing_frequency, status, enrollment_status, currency, amount, tax_behavior)
     VALUES (?, ?, ?, ?, ?, ?, 'EUR', '10.00', 'inclusive')`,
    [gymId, name, over.type ?? 'fee', over.frequency ?? 'month', over.status ?? 'active', over.enrollment ?? 'public']);
  return insertId;
}

beforeAll(async () => {
  gymId = await createTestGym('Me Product Set Draft Gym');
  for (const c of [A, B]) {
    await createTestMembership(gymId, 'member', c);
  }
  const ins = await db.query('INSERT INTO members (gym_id, name, email, clerk_user_id) VALUES (?, ?, ?, ?)', [gymId, 'A', `${A}@t.com`, A]);
  memberA = ins.insertId;
  await db.query('INSERT INTO members (gym_id, name, email, clerk_user_id) VALUES (?, ?, ?, ?)', [gymId, 'B', `${B}@t.com`, B]);
});

afterAll(async () => { await cleanupTestGyms(); await db.end(); });

describe('/me/product-sets draft', () => {
  it('401 without auth', async () => {
    const res = await request.post('/me/product-sets/draft').set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });

  it('creates the member Draft once and reuses it', async () => {
    const first = await as(A, 'post', '/draft');
    expect(first.status).toBe(201);
    expect(first.body.owner_member_id).toBe(memberA);
    expect(first.body.status).toBe('draft');
    const second = await as(A, 'post', '/draft');
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
  });

  it('adds, re-quantifies and removes a catalogue Product; no billing rows are written', async () => {
    const draft = (await as(A, 'post', '/draft')).body;
    const pid = await product('Locker');
    const add = await as(A, 'post', `/${draft.id}/services`).send({ product_id: pid, quantity: 1 });
    expect(add.status).toBe(200);
    const q = await as(A, 'put', `/${draft.id}/services/${add.body.id}`).send({ quantity: 2 });
    expect(q.status).toBe(200);
    const review = await as(A, 'get', `/${draft.id}/review`);
    expect(review.status).toBe(200);
    expect(review.body.status).toBe('draft');
    const sim = await as(A, 'get', `/${draft.id}/billing-event-simulation`);
    expect(sim.status).toBe(200);
    const { rows } = await db.query('SELECT COUNT(*) AS n FROM billing_events WHERE gym_id = ?', [gymId]);
    expect(Number(rows[0].n)).toBe(0);
    const del = await as(A, 'delete', `/${draft.id}/services/${add.body.id}`);
    expect(del.status).toBe(200);
  });

  // #2496 stage 3 — the member adds what the catalogue reports `addable_to_draft`:
  // a Sessions package billed monthly is recurring by its frequency (the staff
  // purchase's rule) and was refused before; a one-time Product never is.
  it('adds a monthly Sessions package and refuses a one-time Product', async () => {
    const draft = (await as(A, 'post', '/draft')).body;
    const duo = await product('Duo class', { type: 'sessions', frequency: 'month' });
    const add = await as(A, 'post', `/${draft.id}/services`).send({ product_id: duo });
    expect(add.status).toBe(200);
    const once = await product('Bottle', { frequency: 'once' });
    const refused = await as(A, 'post', `/${draft.id}/services`).send({ product_id: once });
    expect(refused.status).toBe(400);
    await as(A, 'delete', `/${draft.id}/services/${add.body.id}`);
  });

  it('refuses a staff-only or inactive Product as not found', async () => {
    const draft = (await as(A, 'post', '/draft')).body;
    for (const over of [{ enrollment: 'staff_only' }, { status: 'inactive' }]) {
      const pid = await product(`Hidden-${Math.random()}`, over);
      const res = await as(A, 'post', `/${draft.id}/services`).send({ product_id: pid });
      expect(res.status).toBe(404);
    }
  });

  it("another member cannot read or edit someone else's Draft", async () => {
    const draft = (await as(A, 'post', '/draft')).body;
    const pid = await product('Towel');
    expect((await as(B, 'get', `/${draft.id}/review`)).status).toBe(404);
    expect((await as(B, 'get', `/${draft.id}/billing-event-simulation`)).status).toBe(404);
    expect((await as(B, 'post', `/${draft.id}/services`).send({ product_id: pid })).status).toBe(404);
  });

  it('a Draft of another gym is not reachable', async () => {
    const draft = (await as(A, 'post', '/draft')).body;
    const other = await createTestGym('Me PSD Other Gym');
    await createTestMembership(other, 'member', A);
    const res = await as(A, 'get', `/${draft.id}/review`, other);
    expect(res.status).toBe(404);
  });
});
