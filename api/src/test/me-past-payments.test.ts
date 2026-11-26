// #3437 — the Members App's Past Payments is read a page at a time: the newest
// three first, then the next ones from a cursor, with no payment repeated or
// skipped, narrowed by execution date and by Product before the page is cut.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { verifyToken } from '@clerk/backend';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, ensureTestProductSet, request,
} from './helpers';

const stamp = Date.now();
const ALICE = `mpp-alice-${stamp}`;
const BOB = `mpp-bob-${stamp}`;
const KID = `mpp-kid-${stamp}`;
let gymId: string;
let otherGymId: string;
let ctId: number;
let alice: number;
let bob: number;
let locker: number;
let towel: number;
/** Alice's past payments, newest first, as the API must order them. */
const pastOrder: number[] = [];
let planned: number;
let todayScheduled: number;
let lockerEvents: number[] = [];
let bobPast: number;

function get(clerk: string, path: string, gym = () => gymId) {
  vi.mocked(verifyToken).mockResolvedValue({ sub: clerk } as any);
  return request.get(path).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gym());
}

async function member(name: string, clerk: string): Promise<number> {
  await createTestMembership(gymId, 'member', clerk);
  const { insertId } = await db.query(
    'INSERT INTO members (gym_id, name, email, clerk_user_id) VALUES (?, ?, ?, ?)',
    [gymId, name, `${clerk}@test.com`, clerk]);
  return insertId as number;
}

async function product(name: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO products (gym_id, name, type, amount, currency, billing_frequency, status, availability, is_system)
     VALUES (?, ?, 'fee', 10, 'EUR', 'month', 'active', 'available', 0)`, [gymId, name]);
  return insertId as number;
}

async function event(memberId: number, billingDate: string, opts: { scheduled?: boolean; productId?: number; itemName?: string } = {}) {
  const psId = await ensureTestProductSet(gymId, memberId);
  const { insertId } = await db.query(
    `INSERT INTO billing_events (gym_id, product_set_id, member_id, event_type, amount, charge_type_id, source,
                                 billing_date, is_scheduled)
     VALUES (?, ?, ?, ?, '10.00', ?, 'system', ?, ?)`,
    [gymId, psId, memberId, opts.scheduled ? 'charge_created' : 'payment_recorded', ctId, billingDate, opts.scheduled ? 1 : 0]);
  await db.query(
    `INSERT INTO billing_event_lines (gym_id, billing_event_id, kind, product_id, item_name, quantity, amount)
     VALUES (?, ?, ?, ?, ?, 1, '10.00')`,
    [gymId, insertId, opts.productId ? 'product' : 'membership_fee', opts.productId ?? null, opts.itemName ?? 'Plan']);
  return insertId as number;
}

const today = new Date().toISOString().slice(0, 10);

async function pages(clerk: string, query = '', limit?: number): Promise<number[]> {
  const ids: number[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 50; i += 1) {
    const params = new URLSearchParams(query);
    if (limit) params.set('limit', String(limit));
    if (cursor) params.set('cursor', cursor);
    const res = await get(clerk, `/me/billing-events/past?${params}`);
    expect(res.status).toBe(200);
    ids.push(...res.body.items.map((r: any) => r.id));
    cursor = res.body.next_cursor;
    if (!cursor) break;
  }
  return ids;
}

beforeAll(async () => {
  gymId = await createTestGym('Member Past Payments Gym');
  otherGymId = await createTestGym('Member Past Payments Other Gym');
  const { rows } = await db.query<{ id: number }>("SELECT id FROM charge_types WHERE code = 'membership_fee' LIMIT 1");
  ctId = rows[0].id;
  alice = await member('Alice', ALICE);
  bob = await member('Bob', BOB);
  locker = await product('Locker');
  towel = await product('Towel');

  // Two events share a date, so the id is what keeps the order unique.
  const a = await event(alice, '2026-01-05');
  const b = await event(alice, '2026-02-05', { productId: locker, itemName: 'Locker' });
  const c = await event(alice, '2026-02-05');
  const d = await event(alice, '2026-03-05', { productId: towel, itemName: 'Towel' });
  const e = await event(alice, '2026-04-05', { productId: locker, itemName: 'Locker' });
  const f = await event(alice, '2026-05-05');
  const g = await event(alice, today); // executed today: past
  todayScheduled = await event(alice, today, { scheduled: true }); // still awaiting execution: planned
  planned = await event(alice, '2099-01-01', { scheduled: true, productId: locker, itemName: 'Locker' });
  pastOrder.push(g, f, e, d, c, b, a);
  lockerEvents = [e, b];
  bobPast = await event(bob, '2026-02-05', { productId: locker, itemName: 'Locker' });
});

afterAll(async () => { await cleanupTestGyms(); await db.end(); });

describe('GET /me/billing-events/past (#3437)', () => {
  it('answers the three most recent past payments first, with a cursor to the rest', async () => {
    const res = await get(ALICE, '/me/billing-events/past');
    expect(res.status).toBe(200);
    expect(res.body.items.map((r: any) => r.id)).toEqual(pastOrder.slice(0, 3));
    expect(res.body.next_cursor).toEqual(expect.any(String));
    // The ledger's own shape, so the card reads one payment one way.
    expect(res.body.items[0]).toMatchObject({ status: 'paid', scheduled_date: today, lines: expect.any(Array) });
  });

  it('walks every past payment newest first, none repeated or skipped, and none planned', async () => {
    const ids = await pages(ALICE);
    expect(ids).toEqual(pastOrder);
    expect(ids).not.toContain(planned);
    expect(ids).not.toContain(todayScheduled);
    expect(ids).not.toContain(bobPast);
    // Any page size walks the same set in the same order.
    expect(await pages(ALICE, '', 2)).toEqual(pastOrder);
  });

  it('narrows by execution date range, both ends inclusive', async () => {
    expect(await pages(ALICE, 'date_from=2026-02-05&date_to=2026-04-05')).toEqual(pastOrder.slice(2, 6));
    expect(await pages(ALICE, 'date_to=2026-02-05')).toEqual(pastOrder.slice(4));
  });

  it('narrows by a Product a line of the payment names, and combines with the dates', async () => {
    expect(await pages(ALICE, `product_id=${locker}`)).toEqual(lockerEvents);
    expect(await pages(ALICE, `product_id=${locker}&date_to=2026-03-01`)).toEqual([lockerEvents[1]]);
    const none = await get(ALICE, `/me/billing-events/past?product_id=${towel}&date_from=2026-04-01`);
    expect(none.body).toEqual({ items: [], next_cursor: null });
  });

  it('refuses an unreadable filter, cursor or limit', async () => {
    for (const q of ['date_from=2026-13-01', 'date_from=2026-03-01&date_to=2026-02-01', 'product_id=abc',
      'cursor=nope', 'limit=0', 'limit=500']) {
      expect((await get(ALICE, `/me/billing-events/past?${q}`)).status).toBe(400);
    }
  });

  it('lists as filter options only the Products of the member’s past payments', async () => {
    const res = await get(ALICE, '/me/billing-events/past/products');
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([{ id: locker, name: 'Locker' }, { id: towel, name: 'Towel' }]);
    const bobs = await get(BOB, '/me/billing-events/past/products');
    expect(bobs.body.items).toEqual([{ id: locker, name: 'Locker' }]);
  });

  it('is the Family Owner’s: a family member who does not own it is refused', async () => {
    const kid = await member('Kid', KID);
    const { insertId: familyId } = await db.query('INSERT INTO families (gym_id, name) VALUES (?, ?)', [gymId, 'Fam']);
    await db.query('DELETE FROM family_members WHERE member_id IN (?, ?)', [alice, kid]);
    await db.query(
      `INSERT INTO family_members (gym_id, family_id, member_id, is_owner) VALUES (?, ?, ?, 1), (?, ?, ?, 0)`,
      [gymId, familyId, alice, gymId, familyId, kid]);
    expect((await get(KID, '/me/billing-events/past')).status).toBe(403);
    expect((await get(KID, '/me/billing-events/past/products')).status).toBe(403);
    expect((await get(ALICE, '/me/billing-events/past')).status).toBe(200);
  });

  it('is refused without a session, and finds no member in another gym', async () => {
    expect((await request.get('/me/billing-events/past').set('x-gym-id', gymId)).status).toBe(401);
    const res = await get(ALICE, '/me/billing-events/past', () => otherGymId);
    expect(res.status).not.toBe(200);
  });
});
