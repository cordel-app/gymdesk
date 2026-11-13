// #2776: in a Family only the Family Owner sees the Members App's Payments tab.
// The two reads it draws from (`GET /me/billing-events`, `GET /me/billing-event-forecast`)
// refuse another family member with 403 family_owner_only, whether or not they hold
// payment records, `GET /me/membership` reports the flag the app hides the tab with, and a
// member who is alone in their family (its owner) or in none keeps the tab as before.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { verifyToken } from '@clerk/backend';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';

let gymId: string;
const stamp = Date.now();
const OWNER = `fam-pay-owner-${stamp}`;
const OTHER = `fam-pay-other-${stamp}`;
const SOLO = `fam-pay-solo-${stamp}`;
let owner: number;
let other: number;

function as(clerk: string) {
  vi.mocked(verifyToken).mockResolvedValue({ sub: clerk } as any);
  return (path: string) => request.get(path).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
}

async function member(name: string, clerk: string): Promise<number> {
  await createTestMembership(gymId, 'member', clerk);
  const { insertId } = await db.query(
    'INSERT INTO members (gym_id, name, email, clerk_user_id) VALUES (?, ?, ?, ?)',
    [gymId, name, `${clerk}@test.com`, clerk]);
  return insertId as number;
}

async function billingEvent(memberId: number): Promise<void> {
  await db.query(
    `INSERT INTO billing_events (gym_id, member_id, event_type, amount, source)
     VALUES (?, ?, 'product_purchase', 5.00, 'system')`, [gymId, memberId]);
}

beforeAll(async () => {
  gymId = await createTestGym('Family Owner Payments Gym');
  owner = await member('Owner', OWNER);
  other = await member('Other', OTHER);
  await member('Solo', SOLO);
  await billingEvent(owner);
  await billingEvent(other);
});

afterAll(async () => { await cleanupTestGyms(); await db.end(); });

describe('Family Owner Payments tab (#2776)', () => {
  it('a member with no family row sees Payments (no restriction for an individual member)', async () => {
    const me = await as(OTHER)('/me/membership');
    expect(me.status).toBe(200);
    expect(me.body.can_view_payments).toBe(true);
    expect((await as(OTHER)('/me/billing-events')).status).toBe(200);

    const { insertId: familyId } = await db.query('INSERT INTO families (gym_id, name) VALUES (?, ?)', [gymId, 'F']);
    await db.query('INSERT INTO family_members (gym_id, family_id, member_id, is_owner) VALUES (?, ?, ?, 1)', [gymId, familyId, owner]);
    await db.query('INSERT INTO family_members (gym_id, family_id, member_id, is_owner) VALUES (?, ?, ?, 0)', [gymId, familyId, other]);
  });

  it('reports the flag: true for the Family Owner, false for another family member', async () => {
    expect((await as(OWNER)('/me/membership')).body.can_view_payments).toBe(true);
    expect((await as(OTHER)('/me/membership')).body.can_view_payments).toBe(false);
  });

  it('refuses both Payments reads to a family member who is not the owner, even with payment records', async () => {
    for (const path of ['/me/billing-events', '/me/billing-event-forecast']) {
      const res = await as(OTHER)(path);
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('family_owner_only');
    }
    // Nothing was deleted or changed.
    const { rows } = await db.query<any>('SELECT COUNT(*) AS n FROM billing_events WHERE gym_id = ? AND member_id = ?', [gymId, other]);
    expect(Number(rows[0].n)).toBe(1);
  });

  it('lets the Family Owner read their Payments unchanged', async () => {
    const events = await as(OWNER)('/me/billing-events');
    expect(events.status).toBe(200);
    expect(events.body.items).toHaveLength(1);
    expect((await as(OWNER)('/me/billing-event-forecast')).status).toBe(200);
  });

  it('a member alone in their own family is its owner and keeps Payments', async () => {
    const soloId = (await db.query<any>('SELECT id FROM members WHERE gym_id = ? AND clerk_user_id = ?', [gymId, SOLO])).rows[0].id;
    const { insertId: familyId } = await db.query('INSERT INTO families (gym_id, name) VALUES (?, ?)', [gymId, 'Solo']);
    await db.query('INSERT INTO family_members (gym_id, family_id, member_id, is_owner) VALUES (?, ?, ?, 1)', [gymId, familyId, soloId]);
    expect((await as(SOLO)('/me/membership')).body.can_view_payments).toBe(true);
    expect((await as(SOLO)('/me/billing-events')).status).toBe(200);
  });
});
