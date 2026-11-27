// #3497: a Member's Default Payment Method, read and written by staff from the
// Profile. Automated is the default and is saveable with no MONEI token; the
// write touches neither Billing Events nor payment requests.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';

let gymId: string;
let otherGymId: string;
let memberId: number;
const stamp = Date.now();

function path(id: number = memberId) { return `/members/${id}/default-payment-method`; }
function get(gym = gymId, id?: number) {
  return request.get(path(id)).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gym);
}
function put(body: unknown, gym = gymId) {
  return request.put(path()).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gym).send(body as object);
}

beforeAll(async () => {
  gymId = await createTestGym('Default Payment Method Gym');
  otherGymId = await createTestGym('Default Payment Method Other Gym');
  await createTestMembership(gymId, 'admin');
  await createTestMembership(otherGymId, 'admin');
  const { insertId } = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, 'Pay Member', `dpm-${stamp}@test.com`]);
  memberId = insertId as number;
});

afterAll(async () => { await cleanupTestGyms(); await db.end(); });

describe('/members/:id/default-payment-method (#3497)', () => {
  it('401 without a session', async () => {
    expect((await request.get(path()).set('x-gym-id', gymId)).status).toBe(401);
  });

  it('defaults to Automated and always offers it, with no MONEI token stored', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body.default_payment_method).toBe('automated');
    expect(res.body.is_explicit).toBe(false);
    expect(res.body.options.map((o: any) => o.code)).toContain('automated');
  });

  it('saves Automated with no MONEI token', async () => {
    const res = await put({ default_payment_method: 'automated' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ default_payment_method: 'automated', is_explicit: true });
  });

  it('saves another offered method and touches no Billing Event or payment request', async () => {
    const before = await db.query<any>(
      'SELECT (SELECT COUNT(*) FROM billing_events WHERE gym_id = ?) AS e, (SELECT COUNT(*) FROM payment_requests WHERE gym_id = ?) AS r',
      [gymId, gymId]);
    const res = await put({ default_payment_method: 'cash' });
    expect(res.status).toBe(200);
    expect(res.body.default_payment_method).toBe('cash');
    expect((await get()).body.default_payment_method).toBe('cash');
    const after = await db.query<any>(
      'SELECT (SELECT COUNT(*) FROM billing_events WHERE gym_id = ?) AS e, (SELECT COUNT(*) FROM payment_requests WHERE gym_id = ?) AS r',
      [gymId, gymId]);
    expect(after.rows[0]).toEqual(before.rows[0]);
    // Repeating the save is a no-op.
    expect((await put({ default_payment_method: 'cash' })).status).toBe(200);
  });

  it('refuses an unknown method and a missing field', async () => {
    expect((await put({ default_payment_method: 'bitcoin' })).status).toBe(400);
    expect((await put({})).status).toBe(400);
    expect((await get()).body.default_payment_method).toBe('cash');
  });

  it('a null value resets to Automated', async () => {
    const res = await put({ default_payment_method: null });
    expect(res.body).toMatchObject({ default_payment_method: 'automated', is_explicit: false });
  });

  it('isolates tenants: another gym gets a 404', async () => {
    expect((await get(otherGymId)).status).toBe(404);
    expect((await put({ default_payment_method: 'cash' }, otherGymId)).status).toBe(404);
  });
});
