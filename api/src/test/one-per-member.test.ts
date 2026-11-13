// #2607 — One per Member: persisted on Base and Gym Products, copied on import,
// and enforced on the backend for a one-time purchase and a recurring line.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { importBaseProducts } from '../api/gym-default-products';
import { parseBaseProductInput } from '../domain/baseProducts';
import { violatesOnePerMember } from '../api/one-per-member';
import { cleanupTestGyms, createTestGym, insertTestPurchase } from './helpers';
import { legacyProductInsert } from './legacyProductFixture';

const NAME = 'One Per Member Template (#2607)';
let gymId: string;
let templateId: number;
let memberId: number;
let productId: number;
let plainId: number;

beforeAll(async () => {
  gymId = await createTestGym('One Per Member Gym');
  await db.query('DELETE FROM base_products WHERE name = ?', [NAME]);
  const t = await db.query(
    `INSERT INTO base_products
       (charge_type_code, name, type, amount, billing_frequency, status, enrollment_status,
        mandatory, one_time_purchase, sharing_type, one_per_member, tax_behavior, created_at, created_by)
     VALUES (NULL, ?, 'fee', 10, 'once', 'active', 'public', 0, 0, 'individual', 1, 'inclusive', UTC_TIMESTAMP(), 'test')`,
    [NAME],
  );
  templateId = t.insertId;
  const m = await db.query(
    `INSERT INTO members (gym_id, name, email) VALUES (?, 'Opm Member', 'opm@example.com')`, [gymId]);
  memberId = m.insertId;
  const p = await db.query(
    `INSERT INTO products (gym_id, name, type, amount, currency, billing_frequency, status, enrollment_status, is_system, one_per_member, created_by)
     VALUES (?, 'Locker OPM', 'fee', 10, 'EUR', 'once', 'active', 'public', 0, 1, 'test')`, [gymId]);
  productId = p.insertId;
  const q = await db.query(
    `INSERT INTO products (gym_id, name, type, amount, currency, billing_frequency, status, enrollment_status, is_system, created_by)
     VALUES (?, 'Plain', 'fee', 10, 'EUR', 'once', 'active', 'public', 0, 'test')`, [gymId]);
  plainId = q.insertId;
});

afterAll(async () => {
  await db.query('DELETE FROM product_sets WHERE gym_id = ?', [gymId]);
  await db.query('DELETE FROM products WHERE base_product_id = ?', [templateId]);
  await db.query('DELETE FROM base_products WHERE id = ?', [templateId]);
  await cleanupTestGyms();
  await db.end();
});

describe('One per Member', () => {
  it('defaults to false, parses strictly and is copied on import', async () => {
    const parsed = parseBaseProductInput({ name: 'X' });
    expect('value' in parsed && parsed.value.one_per_member).toBe(false);
    expect('error' in parseBaseProductInput({ name: 'X', one_per_member: 'yes' })).toBe(true);

    await importBaseProducts(gymId, [templateId], 'test');
    const { rows } = await db.query<any>('SELECT one_per_member FROM products WHERE gym_id = ? AND base_product_id = ?', [gymId, templateId]);
    expect(rows[0].one_per_member).toBe(1);
  });

  it('blocks a second assignment only while the member holds one', async () => {
    expect(await violatesOnePerMember(db, gymId, memberId, productId)).toBe(false);
    const ins = (status: string) => insertTestPurchase(
      `INSERT INTO member_products_oneoff_snapshot
         (gym_id, member_id, product_id, status, product_name, product_type, billing_frequency, amount, currency, created_by)
       VALUES (?, ?, ?, ?, 'Locker OPM', 'fee', 'once', 10, 'EUR', 'test')`, [gymId, memberId, productId, status]);
    await ins('cancelled');
    expect(await violatesOnePerMember(db, gymId, memberId, productId)).toBe(false);
    await ins('active');
    expect(await violatesOnePerMember(db, gymId, memberId, productId)).toBe(true);
    // A Product without the flag is never restricted.
    expect(await violatesOnePerMember(db, gymId, memberId, plainId)).toBe(false);
  });

  // #2126 stage 3h: a recurring line is read from `product_periodical_snapshots`, which the
  // Draft writers' dual-write keeps equal to the version's lines.
  it('blocks a Product the member holds as a live recurring line, on any live version or the Draft', async () => {
    const m = await db.query(
      `INSERT INTO members (gym_id, name, email) VALUES (?, 'Opm Recurring', 'opm-rec@example.com')`, [gymId]);
    const owner = m.insertId;
    const lineProduct = (await db.query(
      `INSERT INTO products (gym_id, name, type, amount, currency, billing_frequency, status, enrollment_status, is_system, one_per_member, created_by)
       VALUES (?, 'Locker Monthly OPM', 'service', 10, 'EUR', 'month', 'active', 'public', 0, 1, 'test')`, [gymId])).insertId;
    const setWithLine = async (status: string, endsAt: string | null) => {
      const s = await db.query(
        `INSERT INTO product_sets (gym_id, owner_member_id, status, starts_at) VALUES (?, ?, ?, '2019-01-01')`,
        [gymId, owner, status]);
      await legacyProductInsert(`INSERT INTO member_products_recurrent_snapshot
           (gym_id, product_set_id, product_id, quantity, starts_at, ends_at, item_name, item_type,
            item_billing_frequency, unit_price)
         VALUES (?, ?, ?, 1, '2019-01-01', ?, 'Locker Monthly OPM', 'service', 'month', 10.00)`,
        [gymId, s.insertId, lineProduct, endsAt]);
      return s.insertId;
    };

    // A superseded version and a line that already ended hold nothing.
    await setWithLine('superseded', null);
    const draftId = await setWithLine('draft', '2020-01-31');
    expect(await violatesOnePerMember(db, gymId, owner, lineProduct)).toBe(false);
    expect(await violatesOnePerMember(db, gymId, owner, lineProduct, { draftSetId: draftId })).toBe(false);

    // A running line on the Active version is held, from the member's view and the Draft's own.
    await setWithLine('active', null);
    expect(await violatesOnePerMember(db, gymId, owner, lineProduct)).toBe(true);
    // One in-flight version per owner: the ended Draft goes before the open one is written.
    await db.query('DELETE FROM product_sets WHERE id = ?', [draftId]);
    const openDraft = await setWithLine('draft', null);
    expect(await violatesOnePerMember(db, gymId, owner, lineProduct, { draftSetId: openDraft })).toBe(true);
  });
});
