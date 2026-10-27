// #2123 stage 2: the Family Owner pays for their family's obligations; the beneficiary stays on the record.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../infra/db';
import { cleanupTestGyms, createTestGym, legacyAssignmentQuery } from './helpers';

const provider = vi.hoisted(() => ({ calls: [] as Array<{ orderId: string; paymentToken: string }> }));
vi.mock('../payments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../payments')>()),
  getPaymentProvider: () => ({
    executeRecurring: async (p: { orderId: string; paymentToken: string }) => {
      provider.calls.push(p);
      return { success: true, providerRef: 'ref', providerStatus: 'SUCCEEDED' };
    },
  }),
}));

import { executeDueScheduledEvents } from '../api/scheduled-event-execution';
import { loadCardRemovalBlock } from '../api/card-updates';

let gymId: string;
const TODAY = new Date().toISOString().slice(0, 10);

async function member(name: string, token?: string): Promise<number> {
  const { insertId } = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, name, `fp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`]);
  if (token) {
    await db.query(
      `INSERT INTO payment_methods (gym_id, member_id, provider, payment_token, sequence_id) VALUES (?, ?, 'monei', ?, 'seq')`,
      [gymId, insertId, token]);
  }
  return insertId as number;
}
async function family(owner: number, ...others: number[]) {
  const { insertId } = await db.query('INSERT INTO families (gym_id, name) VALUES (?, ?)', [gymId, 'F']);
  await db.query('INSERT INTO family_members (gym_id, family_id, member_id, is_owner) VALUES (?, ?, ?, 1)', [gymId, insertId, owner]);
  for (const o of others) {
    await db.query('INSERT INTO family_members (gym_id, family_id, member_id, is_owner) VALUES (?, ?, ?, 0)', [gymId, insertId, o]);
  }
}
async function dueEvent(beneficiary: number, billingDate = TODAY) {
  const { rows: existing } = await db.query<{ id: number }>(
    "SELECT id FROM product_sets WHERE gym_id = ? AND owner_member_id = ? AND status = 'active'", [gymId, beneficiary]);
  let setId = existing[0]?.id;
  if (!setId) {
    const s = await db.query(
      `INSERT INTO product_sets (gym_id, owner_member_id, status, starts_at) VALUES (?, ?, 'active', ?)`,
      [gymId, beneficiary, billingDate]);
    setId = s.insertId as number;
    await db.query('UPDATE product_sets SET root_product_set_id = id WHERE id = ?', [setId]);
  }
  const e = await db.query(
    `INSERT INTO billing_events (gym_id, member_id, event_type, source, amount, product_set_id, billing_date, is_scheduled)
     VALUES (?, ?, 'charge_created', 'system', 25, ?, ?, 1)`,
    [gymId, beneficiary, setId, billingDate]);
  return e.insertId as number;
}
async function attempt(eventId: number) {
  const { rows } = await db.query<any>(
    'SELECT member_id, payer_member_id FROM payment_requests WHERE billing_event_id = ?', [eventId]);
  return rows;
}
async function eventPayer(eventId: number) {
  const { rows } = await db.query<any>('SELECT member_id, payer_member_id, is_scheduled FROM billing_events WHERE id = ?', [eventId]);
  return rows[0];
}

beforeAll(async () => {
  gymId = await createTestGym('Family payer gym');
  await db.query("INSERT IGNORE INTO charge_types (code, name, is_system) VALUES ('membership_fee','Membership Fee',1)").catch(() => {});
});
afterEach(() => { provider.calls = []; });
afterAll(async () => {
  await db.query('DELETE FROM payment_requests WHERE gym_id = ?', [gymId]);
  await db.query('DELETE FROM billing_events WHERE gym_id = ?', [gymId]);
  await cleanupTestGyms();
  await db.end();
});

describe('family payer in the nightly run', () => {
  it("charges a family member's obligation to the Family Owner's card and records both", async () => {
    const owner = await member('Owner', 'owner-token');
    const child = await member('Child'); // no card of their own
    await family(owner, child);
    const eventId = await dueEvent(child);
    await executeDueScheduledEvents({ today: TODAY });
    expect(provider.calls.map((c) => c.paymentToken)).toContain('owner-token');
    expect(await attempt(eventId)).toEqual([{ member_id: child, payer_member_id: owner }]);
    expect(await eventPayer(eventId)).toMatchObject({ member_id: child, payer_member_id: owner });
  });

  it("never uses a family member's own card for a family obligation", async () => {
    const owner = await member('Owner2'); // owner has no card
    const child = await member('Child2', 'child-token');
    await family(owner, child);
    const eventId = await dueEvent(child);
    await executeDueScheduledEvents({ today: TODAY });
    expect(provider.calls.map((c) => c.paymentToken)).not.toContain('child-token');
    expect(await attempt(eventId)).toEqual([]);
    expect(Number((await eventPayer(eventId)).is_scheduled)).toBe(1);
  });

  it('a member without a family pays for themselves', async () => {
    const solo = await member('Solo', 'solo-token');
    const eventId = await dueEvent(solo);
    await executeDueScheduledEvents({ today: TODAY });
    expect(provider.calls.map((c) => c.paymentToken)).toContain('solo-token');
    expect(await attempt(eventId)).toEqual([{ member_id: solo, payer_member_id: solo }]);
  });

  it("the owner's own obligation is charged once, to the owner", async () => {
    const owner = await member('Owner3', 'owner3-token');
    const child = await member('Child3');
    await family(owner, child);
    const own = await dueEvent(owner);
    await executeDueScheduledEvents({ today: TODAY });
    expect(await attempt(own)).toHaveLength(1);
  });
});

describe('card removal guard covers the family', () => {
  async function activeAssignment(memberId: number) {
    const { insertId: planId } = await db.query(
      `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status) VALUES (?, ?, 'active', 'staff_only')`,
      [gymId, `FP-Plan-${Date.now()}-${memberId}`]);
    await legacyAssignmentQuery(
      `INSERT INTO user_memberships (gym_id, member_id, membership_plan_id, status, starts_at, base_price)
       VALUES (?, ?, ?, 'active', CURDATE(), '0.00')`, [gymId, memberId, planId]);
  }

  it("blocks the owner's card removal while a family member's obligation is scheduled, not the member's own", async () => {
    const owner = await member('Owner4', 'o4');
    const child = await member('Child4', 'c4');
    await family(owner, child);
    await activeAssignment(child);
    await dueEvent(child, '2999-01-01');
    expect(await loadCardRemovalBlock(gymId, owner)).toBe('billable_membership');
    expect(await loadCardRemovalBlock(gymId, child)).toBeNull();
  });
});
