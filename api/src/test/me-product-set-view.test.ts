// #2496 stage 2 — GET /me/product-sets/:id: the member's own version read from
// its frozen line snapshots (pictures, frozen figures, added/removed lines,
// the Draft's server countdown). Integration against the real stack.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { verifyToken } from '@clerk/backend';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';

let gymId: string;
const A = `me-psv-a-${Date.now()}`;
const B = `me-psv-b-${Date.now()}`;

const as = (clerk: string, method: 'get' | 'post' | 'put' | 'delete', path: string) => {
  vi.mocked(verifyToken).mockResolvedValueOnce({ sub: clerk } as any).mockResolvedValueOnce({ sub: clerk } as any);
  return (request as any)[method](`/me/product-sets${path}`).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
};

async function product(name: string, amount = '10.00'): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO products (gym_id, name, description, type, billing_frequency, status, enrollment_status, currency, amount, tax_behavior, image_url, image_thumbnail_url)
     VALUES (?, ?, ?, 'fee', 'month', 'active', 'public', 'EUR', ?, 'inclusive', ?, ?)`,
    [gymId, name, `${name} description`, amount, `https://cdn.test/${name}.webp`, `https://cdn.test/${name}-thumbnail.webp`]);
  return insertId;
}

beforeAll(async () => {
  gymId = await createTestGym('Me Product Set View Gym');
  for (const c of [A, B]) await createTestMembership(gymId, 'member', c);
  await db.query('INSERT INTO members (gym_id, name, email, clerk_user_id) VALUES (?, ?, ?, ?)', [gymId, 'A', `${A}@t.com`, A]);
  await db.query('INSERT INTO members (gym_id, name, email, clerk_user_id) VALUES (?, ?, ?, ?)', [gymId, 'B', `${B}@t.com`, B]);
});

afterAll(async () => { await cleanupTestGyms(); await db.end(); });

describe('GET /me/product-sets/:id', () => {
  it('401 without auth', async () => {
    const res = await request.get('/me/product-sets/1').set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });

  it("reads the Draft's lines from their snapshots, with picture, frozen figures and countdown", async () => {
    const draft = (await as(A, 'post', '/draft')).body;
    const pid = await product('Locker', '12.00');
    const add = await as(A, 'post', `/${draft.id}/services`).send({ product_id: pid, quantity: 2 });
    expect(add.status).toBe(200);

    // A later catalogue repricing must not move what the Draft shows.
    await db.query("UPDATE products SET amount = '99.00' WHERE id = ?", [pid]);

    const res = await as(A, 'get', `/${draft.id}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('draft');
    expect(res.body.expires_in_seconds).toBeGreaterThan(60 * 110);
    expect(res.body.expires_in_seconds).toBeLessThanOrEqual(60 * 120);
    expect(res.body.lines).toHaveLength(1);
    const line = res.body.lines[0];
    expect(line).toMatchObject({
      id: add.body.id, product_id: pid, product_name: 'Locker', quantity: 2,
      description: 'Locker description',
      image_thumbnail_url: 'https://cdn.test/Locker-thumbnail.webp',
      unit_price: 12, final_amount: 24, change: 'added', promotions: [],
    });
    expect(res.body.removed_lines).toEqual([]);
  });

  it('reads no billing rows into existence', async () => {
    const draft = (await as(A, 'post', '/draft')).body;
    await as(A, 'get', `/${draft.id}`);
    const { rows } = await db.query('SELECT COUNT(*) AS n FROM billing_events WHERE gym_id = ?', [gymId]);
    expect(Number(rows[0].n)).toBe(0);
  });

  it("another member cannot read someone else's version", async () => {
    const draft = (await as(A, 'post', '/draft')).body;
    expect((await as(B, 'get', `/${draft.id}`)).status).toBe(404);
  });

  it('an unknown id is 404', async () => {
    expect((await as(A, 'get', '/999999999')).status).toBe(404);
  });
});
