import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { cleanupTestGyms, createTestGym } from './helpers';
import { addCoverage } from '../api/product-sets';
import { activateWithEvents } from '../api/product-set-configuration';
import { ensureRecurringDraft, startRecurringPurchaseDraft } from '../api/recurring-purchase-draft';
import { revokePromotionMutator } from '../api/product-set-bridge';
import { deleteRecurringLine } from '../api/recurring-line-writer';

// #1991 stage 3: a Product-target Promotion application is owned by the
// recurring line (Product snapshot) it applies to.

let gymId: string;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}`;
const TODAY = new Date().toISOString().slice(0, 10);
const actor = { name: 'T', type: 'staff' };

async function member(): Promise<number> {
  const { insertId } = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, 'M', `line-${uniq()}@example.com`]);
  return insertId;
}
async function product(): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO products (gym_id, name, type, billing_frequency, status, enrollment_status, is_system, currency, amount, tax_behavior)
     VALUES (?, ?, 'fee', 'month', 'active', 'public', 0, 'EUR', 20, 'inclusive')`, [gymId, `Locker-${uniq()}`]);
  return Number(insertId);
}
async function promotion(productId: number, stackable = 1): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO promotions (gym_id, name, starts_at, ends_at, lifecycle_status, stackable,
                             only_applicable_for_new_members, paid_months, applies_to)
     VALUES (?, ?, '2020-01-01', '2099-12-31', 'active', ?, 0, 6, 'product')`, [gymId, `PP-${uniq()}`, stackable]);
  await db.query(
    `INSERT INTO promotion_periodical (gym_id, promotion_id, product_id, quantity, \`action\`, \`value\`)
     VALUES (?, ?, ?, 3, 'percentage_discount', 50)`, [gymId, insertId, productId]);
  return Number(insertId);
}
async function buy(memberId: number, productId: number, promotionIds: number[]) {
  return db.transaction(async (tx) => {
    const out = await startRecurringPurchaseDraft(tx, {
      gymId, memberId, productId, promotionIds, directDiscountPercent: null, actor, today: TODAY });
    if (out.kind !== 'ok') throw new Error(out.kind);
    return out;
  });
}
async function activate(setId: number, owner: number, first: boolean) {
  await db.transaction(async (tx) => {
    if (first) {
      await addCoverage(tx, { gymId, productSetId: setId, memberId: owner, isOwner: true });
    }
    const out = await activateWithEvents(tx, { gymId, productSetId: setId, today: TODAY });
    if (out.kind !== 'ok') throw new Error(out.kind);
  });
}
const apps = async (setId: number) => (await db.query<any>(
  'SELECT id, promotion_id, status, recurrent_snapshot_id FROM user_membership_promotions WHERE product_set_id = ? ORDER BY id', [setId])).rows;

beforeAll(async () => { gymId = await createTestGym('Product promo line owner'); });
afterAll(async () => {
  await db.query('DELETE FROM billing_events WHERE gym_id = ?', [gymId]);
  await cleanupTestGyms();
  await db.end();
});

describe('a Product promotion application is owned by its line (#1991 stage 3)', () => {
  it('records the line, clones it with independent rows, supersedes it on activation and cascades with the line', async () => {
    const m = await member();
    const prod = await product();
    const promo = await promotion(prod);

    const first = await buy(m, prod, [promo]);
    const [a1] = await apps(first.productSetId);
    expect(Number(a1.recurrent_snapshot_id)).toBe(first.lineId);
    expect(a1.status).toBe('applied');
    await activate(first.productSetId, m, true);

    // The successor Draft links the unchanged line (#2126 stage 5c-2c-2) and holds its own copy of the
    // application, on that very line.
    const draft = await db.transaction(async (tx) => {
      const out = await ensureRecurringDraft(tx, { gymId, memberId: m, actor, today: TODAY });
      if (out.kind !== 'ok') throw new Error(out.kind);
      return out.productSetId;
    });
    const copied = await apps(draft);
    expect(copied).toHaveLength(1);
    expect(copied[0].id).not.toBe(a1.id);
    const { rows: line } = await db.query<any>(
      'SELECT id, product_set_id FROM member_products_recurrent_snapshot WHERE id = ?', [copied[0].recurrent_snapshot_id]);
    expect(Number(line[0].product_set_id)).toBe(first.productSetId);
    expect(Number(line[0].id)).toBe(first.lineId);
    const { rows: grants } = await db.query<any>(
      'SELECT user_membership_promotion_id FROM user_membership_promotion_periodical_snapshot WHERE user_membership_promotion_id IN (?, ?)',
      [a1.id, copied[0].id]);
    expect(grants).toHaveLength(2);

    // Revoking in the Draft leaves the active version's application as it was.
    await db.transaction(async (tx) => {
      const r = await revokePromotionMutator(promo, 'T')(tx, { id: draft, gym_id: gymId } as any);
      expect('ok' in r).toBe(true);
    });
    expect((await apps(draft))[0].status).toBe('revoked');
    expect((await apps(first.productSetId))[0].status).toBe('applied');

    // Activating the successor supersedes the predecessor's applied application only.
    await activate(draft, m, false);
    expect((await apps(first.productSetId))[0].status).toBe('superseded');
    expect((await apps(draft))[0].status).toBe('revoked');

    // Deleting the line takes its application and grants with it.
    // #2126 stage 5d-1: through the line writer, which deletes the snapshot the application references.
    await db.transaction((tx) => deleteRecurringLine(tx, gymId, Number(copied[0].recurrent_snapshot_id)));
    expect(await apps(draft)).toHaveLength(0);
    const { rows: gone } = await db.query<any>(
      'SELECT id FROM user_membership_promotion_periodical_snapshot WHERE user_membership_promotion_id = ?', [copied[0].id]);
    expect(gone).toHaveLength(0);
  });

  it('the same Promotion may sit on two independent lines of one Product', async () => {
    const m = await member();
    const prod = await product();
    const promo = await promotion(prod);
    const one = await buy(m, prod, [promo]);
    // An identical purchase within seconds is refused as a double submission (#1865).
    await db.query('UPDATE member_products_recurrent_snapshot SET created_at = created_at - INTERVAL 1 MINUTE WHERE id = ?', [one.lineId]);
    // #2126 stage 3l: the guard reads the line's Product snapshot.
    await db.query('UPDATE product_periodical_snapshots SET created_at = created_at - INTERVAL 1 MINUTE WHERE source_id = ?', [one.lineId]);
    const two = await buy(m, prod, [promo]);
    expect(two.productSetId).toBe(one.productSetId);
    expect(two.lineId).not.toBe(one.lineId);
    const rows = await apps(one.productSetId);
    expect(rows.map((r: any) => Number(r.recurrent_snapshot_id)).sort()).toEqual([one.lineId, two.lineId].sort());
  });
});
