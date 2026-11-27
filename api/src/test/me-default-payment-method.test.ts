// #3503: the Members App Profile shows the member's Default Payment Method,
// read-only. `GET /me/default-payment-method` answers what staff saved through
// `PUT /members/:id/default-payment-method` (#3497), NULL reading as Automated,
// with the catalogue entry's name and images; it writes nothing, and the
// Members App has no route that changes the preference.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { verifyToken } from '@clerk/backend';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';

let gymId: string;
let otherGymId: string;
const stamp = Date.now();
const MEMBER = `dpm-me-${stamp}`;
const OTHER = `dpm-other-${stamp}`;
let memberId: number;

function asMember(clerk = MEMBER, gym = () => gymId) {
  vi.mocked(verifyToken).mockResolvedValue({ sub: clerk } as any);
  return request.get('/me/default-payment-method').set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gym());
}

beforeAll(async () => {
  gymId = await createTestGym('Me Default Payment Method Gym');
  otherGymId = await createTestGym('Me Default Payment Method Other Gym');
  await createTestMembership(gymId, 'member', MEMBER);
  await createTestMembership(otherGymId, 'member', OTHER);
  const { insertId } = await db.query(
    'INSERT INTO members (gym_id, name, email, clerk_user_id) VALUES (?, ?, ?, ?)',
    [gymId, 'Pay Me', `${MEMBER}@test.com`, MEMBER]);
  memberId = insertId as number;
  await db.query('INSERT INTO members (gym_id, name, email, clerk_user_id) VALUES (?, ?, ?, ?)',
    [otherGymId, 'Other', `${OTHER}@test.com`, OTHER]);
});

afterAll(async () => { await cleanupTestGyms(); await db.end(); });

describe('GET /me/default-payment-method (#3503)', () => {
  it('401 without a session', async () => {
    expect((await request.get('/me/default-payment-method').set('x-gym-id', gymId)).status).toBe(401);
  });

  it('a member with no stored preference reads Automated, drawn with the MONEI catalogue entry', async () => {
    const res = await asMember();
    expect(res.status).toBe(200);
    expect(res.body.default_payment_method).toBe('automated');
    expect(res.body.is_explicit).toBe(false);
    expect(res.body.method.code).toBe('automated');
    expect(res.body.method.name).toBeNull();
    const { rows } = await db.query<any>("SELECT image_url FROM base_payment_methods WHERE code = 'monei'");
    expect(res.body.method.image_url).toBe(rows[0]?.image_url ?? null);
  });

  it('reflects the value staff saved, with the catalogue name', async () => {
    await db.query("UPDATE members SET default_payment_method = 'cash' WHERE id = ?", [memberId]);
    const res = await asMember();
    expect(res.status).toBe(200);
    expect(res.body.default_payment_method).toBe('cash');
    expect(res.body.is_explicit).toBe(true);
    expect(res.body.method.code).toBe('cash');
    expect(typeof res.body.method.name).toBe('string');
    expect(res.body.method.name.length).toBeGreaterThan(0);
    await db.query('UPDATE members SET default_payment_method = NULL WHERE id = ?', [memberId]);
  });

  it('is scoped to the caller: another gym\'s member reads their own', async () => {
    await db.query("UPDATE members SET default_payment_method = 'card' WHERE id = ?", [memberId]);
    const res = await asMember(OTHER, () => otherGymId);
    expect(res.status).toBe(200);
    expect(res.body.default_payment_method).toBe('automated');
    await db.query('UPDATE members SET default_payment_method = NULL WHERE id = ?', [memberId]);
  });

  it('is read-only: the Members App has no write for it', async () => {
    vi.mocked(verifyToken).mockResolvedValue({ sub: MEMBER } as any);
    for (const method of ['put', 'patch', 'post'] as const) {
      const res = await request[method]('/me/default-payment-method')
        .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId).send({ default_payment_method: 'cash' });
      expect(res.status).toBe(404);
    }
    const { rows } = await db.query<any>('SELECT default_payment_method FROM members WHERE id = ?', [memberId]);
    expect(rows[0].default_payment_method).toBeNull();
  });

  it('a staff role is refused', async () => {
    await createTestMembership(gymId, 'admin');
    vi.mocked(verifyToken).mockResolvedValue({ sub: 'test-user-id' } as any);
    const res = await request.get('/me/default-payment-method').set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
    expect(res.status).toBe(403);
  });
});
