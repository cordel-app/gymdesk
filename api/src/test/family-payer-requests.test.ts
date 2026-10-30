// #2123 stage 5: a hosted-page payment raised for a family member records the Family Owner as
// payer and the card typed on the page is stored for the owner, never the beneficiary.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { cleanupTestGyms, createTestGym } from './helpers';
import { settlePaymentRequest } from '../api/payment-settlement';
import { resolvePayerFor } from '../api/payer-resolution';

let gymId: string;
let owner: number;
let child: number;
let loner: number;

async function member(name: string): Promise<number> {
  const { insertId } = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, name, `fpr-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`]);
  return insertId as number;
}

async function request(memberId: number, payerId: number | null): Promise<string> {
  const orderId = `ord-${Math.random().toString(36).slice(2)}`;
  await db.query(
    `INSERT INTO payment_requests (gym_id, member_id, payer_member_id, amount, status, provider, provider_order, source, created_by)
     VALUES (?, ?, ?, 10, 'pending', 'monei', ?, 'customer', 'test')`,
    [gymId, memberId, payerId, orderId]);
  return orderId;
}

const log = { info: () => {}, warn: () => {}, error: () => {} } as any;
const payload = (orderId: string) => ({
  orderId, status: 'completed' as const, providerRef: `ref-${orderId}`,
  paymentToken: 'tok', sequenceId: 'seq', cardLast4: '4242', cardBrand: 'visa',
});

async function cardsOf(m: number) {
  const { rows } = await db.query('SELECT 1 FROM payment_methods WHERE gym_id = ? AND member_id = ?', [gymId, m]);
  return rows.length;
}

beforeAll(async () => {
  gymId = await createTestGym('Family payer requests');
  owner = await member('Owner');
  child = await member('Child');
  loner = await member('Loner');
  const f = await db.query('INSERT INTO families (gym_id, name) VALUES (?, ?)', [gymId, 'F']);
  await db.query('INSERT INTO family_members (gym_id, family_id, member_id, is_owner) VALUES (?, ?, ?, 1)', [gymId, f.insertId, owner]);
  await db.query('INSERT INTO family_members (gym_id, family_id, member_id, is_owner) VALUES (?, ?, ?, 0)', [gymId, f.insertId, child]);
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('payer on hosted-page requests', () => {
  it('resolves the owner as payer of a family member and the member for a non-member of any family', async () => {
    expect((await resolvePayerFor(db, gymId, child)).payerMemberId).toBe(owner);
    expect((await resolvePayerFor(db, gymId, loner)).viaFamily).toBe(false);
  });

  it('stores the card on the payer recorded on the request', async () => {
    const order = await request(child, owner);
    await settlePaymentRequest(payload(order), { via: 'webhook', log });
    expect(await cardsOf(owner)).toBe(1);
    expect(await cardsOf(child)).toBe(0);
  });

  it('stores the card on the member when no payer is recorded', async () => {
    const order = await request(loner, null);
    await settlePaymentRequest(payload(order), { via: 'webhook', log });
    expect(await cardsOf(loner)).toBe(1);
  });
});
