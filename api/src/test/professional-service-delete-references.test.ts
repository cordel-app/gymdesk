import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { syncProductSnapshotsOfVersion } from '../api/product-snapshot-sync';
import {
  TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, insertTestPurchase, request,
} from './helpers';

// #2129: deleting a gym Professional Service is refused while Activities, calendar
// events or Product snapshots still reference it; the refusal changes nothing.

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

let gymId: string;

async function service(name: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO professional_services (gym_id, name, is_system, system_key) VALUES (?, ?, 0, NULL)`,
    [gymId, `${name} ${Date.now()}${Math.random().toString(36).slice(2, 6)}`],
  );
  return insertId;
}

function del(id: number) {
  return request.delete(`/professional-services/${id}`)
    .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
}

async function deletedAt(id: number) {
  const { rows } = await db.query('SELECT deleted_at, deleted_by FROM professional_services WHERE id = ?', [id]);
  return rows[0];
}

beforeAll(async () => {
  gymId = await createTestGym('PS Delete Refs Gym');
  await createTestMembership(gymId, 'admin');
});

describe('DELETE /professional-services/:id with references', () => {
  it('blocks when an Activity references it and reports the counts', async () => {
    const id = await service('Act');
    await db.query(
      `INSERT INTO activity_types (gym_id, name, duration_minutes, max_capacity, status, professional_service_id)
       VALUES (?, 'Ref Activity', 30, 5, 'active', ?)`,
      [gymId, id],
    );
    const res = await del(id);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('professional_service_in_use');
    expect(res.body.references).toEqual({ activities: 1, calendar_events: 0, product_snapshots: 0 });
    expect((await deletedAt(id)).deleted_at).toBeNull();
  });

  it('blocks when a Product linked to it has a snapshot, and counts combined categories', async () => {
    const id = await service('Prod');
    await db.query(
      `INSERT INTO activity_types (gym_id, name, duration_minutes, max_capacity, status, professional_service_id)
       VALUES (?, 'Ref Activity 2', 30, 5, 'active', ?)`,
      [gymId, id],
    );
    const { insertId: productId } = await db.query(
      `INSERT INTO products (gym_id, name, type, status, is_system) VALUES (?, 'Linked Product', 'sessions', 'active', 0)`,
      [gymId],
    );
    await db.query('INSERT INTO product_professional_services (gym_id, product_id, professional_service_id) VALUES (?, ?, ?)', [gymId, productId, id]);
    const { insertId: memberId } = await db.query(
      `INSERT INTO members (gym_id, name, email) VALUES (?, 'A B', ?)`,
      [gymId, `ps-del-${Date.now()}@example.com`],
    );
    await insertTestPurchase(
      `INSERT INTO member_products_oneoff_snapshot (gym_id, member_id, product_id, product_name, product_type, amount, currency, status)
       VALUES (?, ?, ?, 'Linked Product', 'sessions', 10, 'EUR', 'active')`,
      [gymId, memberId, productId],
    );
    const res = await del(id);
    expect(res.status).toBe(409);
    expect(res.body.references.activities).toBe(1);
    expect(res.body.references.product_snapshots).toBe(1);
    expect((await deletedAt(id)).deleted_at).toBeNull();
  });

  it('blocks when a recurring Product line of a Product Set references it (#2126 stage 3e)', async () => {
    const id = await service('Recurring');
    const { insertId: productId } = await db.query(
      `INSERT INTO products (gym_id, name, type, billing_frequency, status, is_system)
       VALUES (?, 'Linked Locker', 'service', 'month', 'active', 0)`,
      [gymId],
    );
    await db.query('INSERT INTO product_professional_services (gym_id, product_id, professional_service_id) VALUES (?, ?, ?)', [gymId, productId, id]);
    const { insertId: memberId } = await db.query(
      `INSERT INTO members (gym_id, name, email) VALUES (?, 'C D', ?)`,
      [gymId, `ps-del-rec-${Date.now()}@example.com`],
    );
    const { insertId: setId } = await db.query(
      `INSERT INTO product_sets (gym_id, owner_member_id, status, starts_at) VALUES (?, ?, 'superseded', '2026-01-01')`,
      [gymId, memberId],
    );
    await db.query('UPDATE product_sets SET root_product_set_id = id WHERE id = ?', [setId]);
    await db.query(
      `INSERT INTO member_products_recurrent_snapshot
         (gym_id, product_set_id, product_id, quantity, starts_at, item_name, item_type, item_billing_frequency, unit_price)
       VALUES (?, ?, ?, 1, '2026-01-01', 'Linked Locker', 'service', 'month', 10.00)`,
      [gymId, setId, productId],
    );
    await db.transaction((tx) => syncProductSnapshotsOfVersion(tx, gymId, setId));
    const res = await del(id);
    expect(res.status).toBe(409);
    expect(res.body.references).toEqual({ activities: 0, calendar_events: 0, product_snapshots: 1 });
    expect((await deletedAt(id)).deleted_at).toBeNull();
  });

  it('soft-deletes with deleted_at and deleted_by when nothing references it', async () => {
    const id = await service('Free');
    const res = await del(id);
    expect(res.status).toBe(204);
    const row = await deletedAt(id);
    expect(row.deleted_at).not.toBeNull();
    expect(row.deleted_by).toBeTruthy();
  });
});
