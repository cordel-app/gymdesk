// #3512: after signing in, a member whose Default Payment Method is Automated
// (every member until #3497 stores one) and who has no MONEI token stored is
// told to register with the payment gateway. `GET /me/payment-gateway-status`
// is the read the Members App asks; it writes nothing, so the warning stops as
// soon as a token exists. A family member who does not pay is never told.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { verifyToken } from '@clerk/backend';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';

let gymId: string;
let otherGymId: string;
const stamp = Date.now();
const SOLO = `gw-solo-${stamp}`;
const OWNER = `gw-owner-${stamp}`;
const CHILD = `gw-child-${stamp}`;
let solo: number;
let owner: number;
let child: number;

function as(clerk: string, gym = () => gymId) {
  vi.mocked(verifyToken).mockResolvedValue({ sub: clerk } as any);
  return () => request.get('/me/payment-gateway-status').set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gym());
}

async function member(name: string, clerk: string): Promise<number> {
  await createTestMembership(gymId, 'member', clerk);
  const { insertId } = await db.query(
    'INSERT INTO members (gym_id, name, email, clerk_user_id) VALUES (?, ?, ?, ?)',
    [gymId, name, `${clerk}@test.com`, clerk]);
  return insertId as number;
}

async function storeToken(memberId: number, provider: string, token: string | null) {
  await db.query(
    'INSERT INTO payment_methods (gym_id, member_id, provider, payment_token) VALUES (?, ?, ?, ?)',
    [gymId, memberId, provider, token]);
}

beforeAll(async () => {
  gymId = await createTestGym('Payment Gateway Warning Gym');
  otherGymId = await createTestGym('Payment Gateway Other Gym');
  solo = await member('Solo', SOLO);
  owner = await member('Owner', OWNER);
  child = await member('Child', CHILD);
  const { insertId: familyId } = await db.query('INSERT INTO families (gym_id, name) VALUES (?, ?)', [gymId, 'F']);
  await db.query('INSERT INTO family_members (gym_id, family_id, member_id, is_owner) VALUES (?, ?, ?, 1)', [gymId, familyId, owner]);
  await db.query('INSERT INTO family_members (gym_id, family_id, member_id, is_owner) VALUES (?, ?, ?, 0)', [gymId, familyId, child]);
});

afterAll(async () => { await cleanupTestGyms(); await db.end(); });

describe('GET /me/payment-gateway-status (#3512)', () => {
  it('401 without a session', async () => {
    const res = await request.get('/me/payment-gateway-status').set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });

  it('asks an Automated member with no MONEI token to register', async () => {
    const res = await as(SOLO)();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ default_payment_method: 'automated', has_monei_token: false, registration_required: true });
  });

  it('a stored row with no token, or another provider, is not a MONEI token', async () => {
    await storeToken(solo, 'monei', null);
    expect((await as(SOLO)()).body.registration_required).toBe(true);
    await db.query('DELETE FROM payment_methods WHERE gym_id = ? AND member_id = ?', [gymId, solo]);
    await storeToken(solo, 'other', 'tok_other');
    expect((await as(SOLO)()).body.registration_required).toBe(true);
    await db.query('DELETE FROM payment_methods WHERE gym_id = ? AND member_id = ?', [gymId, solo]);
  });

  it('#3497: reads the stored Default Payment Method, and only Automated asks to register', async () => {
    await db.query("UPDATE members SET default_payment_method = 'cash' WHERE id = ?", [solo]);
    expect((await as(SOLO)()).body).toEqual({ default_payment_method: 'cash', has_monei_token: false, registration_required: false });
    await db.query('UPDATE members SET default_payment_method = NULL WHERE id = ?', [solo]);
  });

  it('stops asking once a MONEI token is stored, and writes nothing', async () => {
    await storeToken(solo, 'monei', 'tok_monei');
    const res = await as(SOLO)();
    expect(res.body).toEqual({ default_payment_method: 'automated', has_monei_token: true, registration_required: false });
    const { rows } = await db.query<any>('SELECT COUNT(*) AS n FROM payment_methods WHERE gym_id = ? AND member_id = ?', [gymId, solo]);
    expect(Number(rows[0].n)).toBe(1);
  });

  it('asks the Family Owner, never a family member whose charges the owner pays', async () => {
    expect((await as(OWNER)()).body.registration_required).toBe(true);
    const childRes = await as(CHILD)();
    expect(childRes.status).toBe(200);
    expect(childRes.body.registration_required).toBe(false);
  });

  it('is scoped to the gym: the member is not found in another gym', async () => {
    const res = await as(SOLO, () => otherGymId)();
    expect([403, 404]).toContain(res.status);
  });
});
