import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { cleanupTestGyms, createTestGym } from './helpers';
import {
  activate, addCoverage, cancelInFlight, createDraft, expireDrafts, submitForPayment, touchDraft,
} from '../api/product-sets';

let gymId: string;
let memberId: number;
let otherMemberId: number;
const actor = { name: 'Test Staff', type: 'staff' };

async function member(email: string): Promise<number> {
  const { insertId } = await db.query(
    'INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)', [gymId, 'Member', email]);
  return insertId;
}
const today = () => new Date().toISOString().slice(0, 10);

async function status(id: number): Promise<string | null> {
  const { rows } = await db.query<{ status: string }>('SELECT status FROM product_sets WHERE id = ?', [id]);
  return rows[0]?.status ?? null;
}

beforeAll(async () => {
  gymId = await createTestGym('ProductSet Gym');
  memberId = await member(`ps-a-${Date.now()}@example.com`);
  otherMemberId = await member(`ps-b-${Date.now()}@example.com`);
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('ProductSet versioning (#1325)', () => {
  it('creates a plan-less v1 chain whose root is itself', async () => {
    const out = await db.transaction((tx) => createDraft(tx, {
      gymId, ownerMemberId: memberId, membershipPlanId: null, startsAt: today(), actor }));
    expect(out.kind).toBe('created');
    if (out.kind !== 'created') return;
    expect(out.productSet.version).toBe(1);
    expect(Number(out.productSet.root_product_set_id)).toBe(Number(out.productSet.id));
    expect(out.productSet.membership_plan_id).toBeNull();
    await db.transaction((tx) => cancelInFlight(tx, gymId, out.productSet.id));
  });

  it('refuses a second in-flight version for the same owner', async () => {
    const first = await db.transaction((tx) => createDraft(tx, {
      gymId, ownerMemberId: memberId, membershipPlanId: null, startsAt: today(), actor }));
    const second = await db.transaction((tx) => createDraft(tx, {
      gymId, ownerMemberId: memberId, membershipPlanId: null, startsAt: today(), actor }));
    expect(second.kind).toBe('in_flight');
    if (first.kind === 'created') await db.transaction((tx) => cancelInFlight(tx, gymId, first.productSet.id));
  });

  it('the database itself refuses two in-flight rows for one owner', async () => {
    const a = await db.query(
      `INSERT INTO product_sets (gym_id, owner_member_id, status, starts_at) VALUES (?, ?, 'draft', ?)`,
      [gymId, otherMemberId, today()]);
    await expect(db.query(
      `INSERT INTO product_sets (gym_id, owner_member_id, status, starts_at) VALUES (?, ?, 'pending_payment', ?)`,
      [gymId, otherMemberId, today()])).rejects.toThrow();
    await db.query('DELETE FROM product_sets WHERE id = ?', [a.insertId]);
  });

  it('activation supersedes the previous Active version atomically; a Draft supersedes nothing', async () => {
    const v1 = await db.transaction(async (tx) => {
      const d = await createDraft(tx, { gymId, ownerMemberId: otherMemberId, membershipPlanId: null, startsAt: today(), actor });
      if (d.kind !== 'created') throw new Error('expected created');
      await activate(tx, gymId, d.productSet.id);
      return d.productSet;
    });
    expect(await status(v1.id)).toBe('active');

    const draft = await db.transaction((tx) => createDraft(tx, {
      gymId, ownerMemberId: otherMemberId, membershipPlanId: null, startsAt: today(), actor }));
    if (draft.kind !== 'created') throw new Error('expected created');
    expect(draft.productSet.version).toBe(2);
    expect(Number(draft.productSet.previous_product_set_id)).toBe(Number(v1.id));
    // §2: the existing version stays Active while the replacement is a Draft…
    expect(await status(v1.id)).toBe('active');
    // …and while it awaits payment.
    await db.transaction((tx) => submitForPayment(tx, gymId, draft.productSet.id));
    expect(await status(v1.id)).toBe('active');
    expect(await status(draft.productSet.id)).toBe('pending_payment');

    await db.transaction((tx) => activate(tx, gymId, draft.productSet.id));
    expect(await status(v1.id)).toBe('superseded');
    expect(await status(draft.productSet.id)).toBe('active');

    const { rows } = await db.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM product_sets WHERE owner_member_id = ? AND status = 'active'`, [otherMemberId]);
    expect(Number(rows[0].n)).toBe(1);
  });

  it('activation is idempotent (a duplicate webhook changes nothing)', async () => {
    const { rows } = await db.query<{ id: number }>(
      `SELECT id FROM product_sets WHERE owner_member_id = ? AND status = 'active'`, [otherMemberId]);
    const out = await db.transaction((tx) => activate(tx, gymId, rows[0].id));
    expect(out.kind).toBe('ok');
    const { rows: after } = await db.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM product_sets WHERE owner_member_id = ? AND status = 'superseded'`, [otherMemberId]);
    expect(Number(after[0].n)).toBe(1);
  });

  it('cancelling an in-flight set leaves the Active and Superseded versions alone', async () => {
    const draft = await db.transaction((tx) => createDraft(tx, {
      gymId, ownerMemberId: otherMemberId, membershipPlanId: null, startsAt: today(), actor }));
    if (draft.kind !== 'created') throw new Error('expected created');
    const out = await db.transaction((tx) => cancelInFlight(tx, gymId, draft.productSet.id));
    expect(out.kind).toBe('cancelled');
    const { rows } = await db.query<{ status: string }>(
      `SELECT status FROM product_sets WHERE owner_member_id = ? ORDER BY version`, [otherMemberId]);
    expect(rows.map((r) => r.status)).toEqual(['superseded', 'active']);
  });

  it('is tenant scoped: another gym cannot move a set', async () => {
    const otherGym = await createTestGym('Other Gym');
    const { rows } = await db.query<{ id: number }>(
      `SELECT id FROM product_sets WHERE owner_member_id = ? AND status = 'active'`, [otherMemberId]);
    const out = await db.transaction((tx) => cancelInFlight(tx, otherGym, rows[0].id));
    expect(out.kind).toBe('not_found');
  });
});

describe('Draft expiry (#1325)', () => {
  it('an expired Draft cannot be touched, is replaced by a new one and is swept', async () => {
    const owner = await member(`ps-c-${Date.now()}@example.com`);
    const d = await db.transaction((tx) => createDraft(tx, {
      gymId, ownerMemberId: owner, membershipPlanId: null, startsAt: today(), actor }));
    if (d.kind !== 'created') throw new Error('expected created');
    expect(await db.transaction((tx) => touchDraft(tx, gymId, d.productSet.id))).toBe(true);

    await db.query(
      `UPDATE product_sets SET last_activity_at = UTC_TIMESTAMP() - INTERVAL 121 MINUTE WHERE id = ?`, [d.productSet.id]);
    expect(await db.transaction((tx) => touchDraft(tx, gymId, d.productSet.id))).toBe(false);
    expect((await db.transaction((tx) => submitForPayment(tx, gymId, d.productSet.id))).kind).toBe('expired');

    // A new Draft is allowed: the stale one is removed from the in-flight slot.
    const fresh = await db.transaction((tx) => createDraft(tx, {
      gymId, ownerMemberId: owner, membershipPlanId: null, startsAt: today(), actor }));
    expect(fresh.kind).toBe('created');
    expect(await status(d.productSet.id)).toBeNull();
  });

  it('the sweep deletes only idle Drafts and never a Pending Payment set', async () => {
    const ownerA = await member(`ps-d-${Date.now()}@example.com`);
    const ownerB = await member(`ps-e-${Date.now()}@example.com`);
    const idle = await db.query(
      `INSERT INTO product_sets (gym_id, owner_member_id, status, starts_at, last_activity_at)
       VALUES (?, ?, 'draft', ?, UTC_TIMESTAMP() - INTERVAL 3 HOUR)`, [gymId, ownerA, today()]);
    const pending = await db.query(
      `INSERT INTO product_sets (gym_id, owner_member_id, status, starts_at, last_activity_at)
       VALUES (?, ?, 'pending_payment', ?, UTC_TIMESTAMP() - INTERVAL 3 HOUR)`, [gymId, ownerB, today()]);
    await expireDrafts();
    expect(await status(idle.insertId)).toBeNull();
    expect(await status(pending.insertId)).toBe('pending_payment');
  });
});

describe('family coverage follows the chain (#1325 B1)', () => {
  it('a covered member references the chain root, once, never a copy', async () => {
    const owner = await member(`ps-f-${Date.now()}@example.com`);
    const covered = await member(`ps-g-${Date.now()}@example.com`);
    const d = await db.transaction(async (tx) => {
      const out = await createDraft(tx, { gymId, ownerMemberId: owner, membershipPlanId: null, startsAt: today(), actor });
      if (out.kind !== 'created') throw new Error('expected created');
      await activate(tx, gymId, out.productSet.id);
      await addCoverage(tx, { gymId, rootProductSetId: out.productSet.id, memberId: owner, isOwner: true });
      await addCoverage(tx, { gymId, rootProductSetId: out.productSet.id, memberId: covered, isOwner: false });
      await addCoverage(tx, { gymId, rootProductSetId: out.productSet.id, memberId: covered, isOwner: false });
      return out.productSet;
    });
    const { rows } = await db.query<{ n: number }>(
      'SELECT COUNT(*) AS n FROM product_set_members WHERE root_product_set_id = ?', [d.id]);
    expect(Number(rows[0].n)).toBe(2);

    // The next version shares the root, so the coverage rows need no change.
    const next = await db.transaction((tx) => createDraft(tx, {
      gymId, ownerMemberId: owner, membershipPlanId: null, startsAt: today(), actor }));
    if (next.kind !== 'created') throw new Error('expected created');
    expect(Number(next.productSet.root_product_set_id)).toBe(Number(d.id));
    const { rows: sets } = await db.query<{ n: number }>(
      'SELECT COUNT(*) AS n FROM product_sets WHERE root_product_set_id = ?', [d.id]);
    expect(Number(sets[0].n)).toBe(2);
  });
});
