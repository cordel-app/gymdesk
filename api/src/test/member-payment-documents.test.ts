// #2936 — a member downloads the latest Receipt, Invoice and Refund Receipt of
// their own payments from My Products → Payments. Only stored documents are
// listed, nothing is issued on download, and another member's are a 404.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const stored = new Map<string, Buffer>();
vi.mock('../infra/private-storage', () => ({
  isPrivateStorageConfigured: () => true,
  putPrivateDocument: async (key: string, body: Buffer) => {
    if (stored.has(key)) throw new Error('already exists');
    stored.set(key, body); return key;
  },
  getPrivateDocument: async (key: string) => ({ body: stored.get(key)!, contentType: 'application/pdf' }),
  privateObjectExists: async (key: string) => stored.has(key),
}));

import { verifyToken } from '@clerk/backend';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request, ensureTestProductSet,
} from './helpers';

const stamp = Date.now();
const ALICE = `mpd-alice-${stamp}`;
const BOB = `mpd-bob-${stamp}`;
let gymId: string;
let otherGymId: string;
let alice: number;
let ctId: number;

function as(clerk: string, gym = () => gymId) {
  vi.mocked(verifyToken).mockResolvedValue({ sub: clerk } as any);
  return (path: string) => request.get(path).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gym())
    .buffer(true).parse((res: any, cb: any) => {
      const c: Buffer[] = []; res.on('data', (d: Buffer) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c)));
    });
}
const json = (r: any) => JSON.parse((r.body as Buffer).toString());

async function member(name: string, clerk: string): Promise<number> {
  await createTestMembership(gymId, 'member', clerk);
  const { insertId } = await db.query(
    'INSERT INTO members (gym_id, name, email, clerk_user_id) VALUES (?, ?, ?, ?)',
    [gymId, name, `${clerk}@test.com`, clerk]);
  return insertId as number;
}

async function event(memberId: number, receiptNumber: string | null): Promise<number> {
  const psId = await ensureTestProductSet(gymId, memberId);
  const { insertId } = await db.query(
    `INSERT INTO billing_events (gym_id, product_set_id, member_id, event_type, amount, charge_type_id, source,
                                 receipt_number, receipt_issued_at)
     VALUES (?, ?, ?, 'payment_recorded', '40.00', ?, 'system', ?, IF(? IS NULL, NULL, UTC_TIMESTAMP()))`,
    [gymId, psId, memberId, ctId, receiptNumber, receiptNumber]);
  await db.query(
    `INSERT INTO billing_event_lines (gym_id, billing_event_id, kind, item_name, quantity, amount)
     VALUES (?, ?, 'product', 'Membership fee', 1, '40.00')`, [gymId, insertId]);
  return insertId as number;
}

async function invoice(eventId: number, type: 'simplified' | 'full', number: string, opts: { stored?: boolean; replaces?: number } = {}) {
  const key = opts.stored === false ? null : `test/${number}-${Math.random()}.pdf`;
  if (key) stored.set(key, Buffer.from(`%PDF invoice ${number}`));
  const col = type === 'simplified' ? 'simplified_not_paid_pdf_key' : 'full_paid_pdf_key';
  const { insertId } = await db.query(
    `INSERT INTO invoices (gym_id, billing_event_id, invoice_type, status, fiscal_number, fiscal_year,
                           customer_name, customer_tax_id, customer_address, issued_at, payment_status,
                           replaces_invoice_id, ${col})
     VALUES (?, ?, ?, 'issued', ?, 2026, ?, ?, ?, UTC_TIMESTAMP(), 'paid', ?, ?)`,
    [gymId, eventId, type, number, type === 'full' ? 'Alice' : null, type === 'full' ? '12345678Z' : null,
      type === 'full' ? 'Street 1' : null, opts.replaces ?? null, key]);
  return insertId as number;
}

async function refundReceipt(eventId: number, memberId: number, number: string): Promise<number> {
  const { insertId: orig } = await db.query(
    `INSERT INTO payment_requests (gym_id, member_id, amount, currency, charge_type_id, billing_event_id, status,
                                   provider, provider_order, source, attempt, method)
     VALUES (?, ?, '40.00', 'EUR', ?, ?, 'completed', 'manual', UUID(), 'manual', 1, 'cash')`,
    [gymId, memberId, ctId, eventId]);
  const { insertId: refund } = await db.query(
    `INSERT INTO payment_requests (gym_id, member_id, amount, currency, status, provider, provider_order, source,
                                   attempt, method, transaction_type, refund_of_payment_request_id, completed_at)
     VALUES (?, ?, '5.00', 'EUR', 'completed', 'manual', UUID(), 'manual', 1, 'cash', 'refund', ?, UTC_TIMESTAMP())`,
    [gymId, memberId, orig]);
  const key = `test/${number}-${Math.random()}.pdf`;
  stored.set(key, Buffer.from(`%PDF refund ${number}`));
  const { insertId } = await db.query(
    `INSERT INTO refund_receipts (gym_id, payment_request_id, original_payment_request_id, billing_event_id,
                                  receipt_number, issued_at, pdf_key)
     VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP(), ?)`,
    [gymId, refund, orig, eventId, number, key]);
  return insertId as number;
}

let full: number;
let simplified: number;
let older: number;
let latest: number;
let documented: number;
let bare: number;

beforeAll(async () => {
  gymId = await createTestGym('Member Payment Documents Gym');
  otherGymId = await createTestGym('Member Payment Documents Other');
  const { rows } = await db.query<{ id: number }>("SELECT id FROM charge_types WHERE code = 'membership_fee' LIMIT 1");
  ctId = rows[0].id;
  alice = await member('Alice', ALICE);
  await member('Bob', BOB);

  documented = await event(alice, `2026-${stamp % 10000}`);
  simplified = await invoice(documented, 'simplified', `S-${stamp}`);
  full = await invoice(documented, 'full', `F-${stamp}`, { replaces: simplified });
  older = await refundReceipt(documented, alice, `R-${stamp}-1`);
  latest = await refundReceipt(documented, alice, `R-${stamp}-2`);

  bare = await event(alice, null);
  await invoice(bare, 'simplified', `S-${stamp}-unstored`, { stored: false });
});

afterAll(async () => { await cleanupTestGyms(); await db.end(); });

describe('GET /me/billing-events documents (#2936)', () => {
  it('lists the latest stored document of each kind and hides the rest', async () => {
    const res = await as(ALICE)('/me/billing-events');
    expect(res.status).toBe(200);
    const items = json(res).items;
    const row = items.find((i: any) => i.id === documented);
    expect(row.documents).toEqual([
      { kind: 'receipt', id: documented, number: `2026-${stamp % 10000}` },
      { kind: 'full_invoice', id: full, number: `F-${stamp}` },
      { kind: 'refund_receipt', id: latest, number: `R-${stamp}-2` },
    ]);
    // No receipt, an invoice with no stored document: nothing at all.
    expect(items.find((i: any) => i.id === bare).documents).toEqual([]);
  });
});

describe('GET /me/billing-events lines (#2937)', () => {
  it('returns each event\'s own stored lines, as stored', async () => {
    const items = json(await as(ALICE)('/me/billing-events')).items;
    const row = items.find((i: any) => i.id === documented);
    expect(row.lines).toHaveLength(1);
    expect(row.lines[0]).toMatchObject({ kind: 'product', item_name: 'Membership fee', quantity: 1, amount: '40.00' });
    // Lines belong to their own event only.
    expect(items.find((i: any) => i.id === bare).lines).toHaveLength(1);
    expect(row.lines[0].id).not.toBe(items.find((i: any) => i.id === bare).lines[0].id);
  });

  it("never returns another member's lines", async () => {
    const items = json(await as(BOB)('/me/billing-events')).items;
    expect(items.some((i: any) => i.id === documented || i.id === bare)).toBe(false);
  });
});

describe('member document downloads (#2936)', () => {
  it('serves the member their own invoice and refund receipt from storage', async () => {
    const inv = await as(ALICE)(`/me/invoices/${full}/pdf`);
    expect(inv.status).toBe(200);
    expect(inv.headers['content-type']).toMatch(/application\/pdf/);
    expect((inv.body as Buffer).toString()).toBe(`%PDF invoice F-${stamp}`);

    const rr = await as(ALICE)(`/me/refund-receipts/${latest}/pdf`);
    expect(rr.status).toBe(200);
    expect((rr.body as Buffer).toString()).toBe(`%PDF refund R-${stamp}-2`);

    // A download issues nothing.
    const { rows } = await db.query<any>(
      'SELECT (SELECT COUNT(*) FROM invoices WHERE billing_event_id = ?) AS inv, (SELECT COUNT(*) FROM refund_receipts WHERE billing_event_id = ?) AS rr',
      [documented, documented]);
    expect(Number(rows[0].inv)).toBe(2);
    expect(Number(rows[0].rr)).toBe(2);
  });

  it('refuses a superseded document: the replaced invoice and the older refund receipt', async () => {
    expect((await as(ALICE)(`/me/invoices/${simplified}/pdf`)).status).toBe(404);
    expect((await as(ALICE)(`/me/refund-receipts/${older}/pdf`)).status).toBe(404);
  });

  it("refuses another member's documents and another gym's", async () => {
    expect((await as(BOB)(`/me/invoices/${full}/pdf`)).status).toBe(404);
    expect((await as(BOB)(`/me/refund-receipts/${latest}/pdf`)).status).toBe(404);
    expect((await as(BOB)(`/me/receipts/${documented}`)).status).toBe(404);
    const CAROL = `mpd-carol-${stamp}`;
    await createTestMembership(otherGymId, 'member', CAROL);
    await db.query('INSERT INTO members (gym_id, name, email, clerk_user_id) VALUES (?, ?, ?, ?)',
      [otherGymId, 'Carol', `${CAROL}@test.com`, CAROL]);
    expect((await as(CAROL, () => otherGymId)(`/me/invoices/${full}/pdf`)).status).toBe(404);
    expect((await as(CAROL, () => otherGymId)(`/me/refund-receipts/${latest}/pdf`)).status).toBe(404);
  });

  it('requires authentication', async () => {
    const res = await request.get(`/me/invoices/${full}/pdf`).set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });

  it('refuses a family member who is not the Family Owner', async () => {
    const { rows } = await db.query<any>('SELECT family_id FROM family_members WHERE member_id = ?', [alice]);
    const bobId = (await db.query<any>('SELECT id FROM members WHERE clerk_user_id = ? AND gym_id = ?', [BOB, gymId])).rows[0].id;
    const { rows: bobFam } = await db.query<any>('SELECT family_id FROM family_members WHERE member_id = ?', [bobId]);
    // Move Alice into Bob's family as a non-owner.
    if (rows[0]) await db.query('DELETE FROM family_members WHERE member_id = ?', [alice]);
    let familyId = bobFam[0]?.family_id;
    if (!familyId) {
      familyId = (await db.query('INSERT INTO families (gym_id, name) VALUES (?, ?)', [gymId, 'F'])).insertId;
      await db.query('INSERT INTO family_members (gym_id, family_id, member_id, is_owner) VALUES (?, ?, ?, 1)', [gymId, familyId, bobId]);
    }
    await db.query('INSERT INTO family_members (gym_id, family_id, member_id, is_owner) VALUES (?, ?, ?, 0)', [gymId, familyId, alice]);
    for (const path of [`/me/invoices/${full}/pdf`, `/me/refund-receipts/${latest}/pdf`, `/me/receipts/${documented}`]) {
      const res = await as(ALICE)(path);
      expect(res.status).toBe(403);
      expect(json(res).error).toBe('family_owner_only');
    }
  });
});
