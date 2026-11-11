// #2662: a Product linked to one or more Professional Services is always Family
// (stored `sharing_type = 'shared'`), enforced by the API.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

async function createProfessionalService(gymId: string, name: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO professional_services (gym_id, name, is_system, system_key) VALUES (?, ?, 0, NULL)`,
    [gymId, name],
  );
  await db.query(
    `INSERT INTO gym_professional_services (gym_id, professional_service_id, status) VALUES (?, ?, 'active')`,
    [gymId, insertId],
  );
  return insertId;
}

describe('Product sharing type and Professional Service links (#2662)', () => {
  let gymId: string;
  let psId: number;
  const post = (body: object) =>
    request.post('/products').set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId).send(body);
  const put = (id: number, body: object) =>
    request.put(`/products/${id}`).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId).send(body);

  beforeAll(async () => {
    gymId = await createTestGym('Sharing Type Gym');
    await createTestMembership(gymId, 'admin');
    psId = await createProfessionalService(gymId, 'Personal Training');
  });

  it('creates a linked Product as Family when no sharing type is sent', async () => {
    const res = await post({ name: 'PT Pack A', type: 'sessions', units: 5, professional_service_ids: [psId] });
    expect(res.status).toBe(201);
    expect(res.body.sharing_type).toBe('shared');
  });

  it('refuses to create a linked Product as Individual', async () => {
    const res = await post({
      name: 'PT Pack B', type: 'sessions', units: 5, professional_service_ids: [psId], sharing_type: 'individual',
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('sharing_type_family_required');
    const { rows } = await db.query('SELECT id FROM products WHERE gym_id = ? AND name = ?', [gymId, 'PT Pack B']);
    expect(rows).toHaveLength(0);
  });

  it('keeps an unlinked Product Individual', async () => {
    const res = await post({ name: 'Locker', type: 'service' });
    expect(res.status).toBe(201);
    expect(res.body.sharing_type).toBe('individual');
  });

  it('linking a Professional Service to an Individual Product makes it Family', async () => {
    const created = await post({ name: 'PT Pack C', type: 'sessions', units: 5 });
    expect(created.body.sharing_type).toBe('individual');
    const res = await put(created.body.id, { professional_service_ids: [psId] });
    expect(res.status).toBe(200);
    expect(res.body.sharing_type).toBe('shared');
  });

  it('refuses Individual while a link remains, even when the request leaves the links alone', async () => {
    const created = await post({ name: 'PT Pack D', type: 'sessions', units: 5, professional_service_ids: [psId] });
    const res = await put(created.body.id, { sharing_type: 'individual' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('sharing_type_family_required');
    const { rows } = await db.query<{ sharing_type: string }>(
      'SELECT sharing_type FROM products WHERE id = ?', [created.body.id]);
    expect(rows[0].sharing_type).toBe('shared');
  });

  it('unlinking keeps Family, and Individual is allowed once nothing is linked', async () => {
    const created = await post({ name: 'PT Pack E', type: 'sessions', units: 5, professional_service_ids: [psId] });
    const unlinked = await put(created.body.id, { professional_service_ids: [] });
    expect(unlinked.status).toBe(200);
    expect(unlinked.body.sharing_type).toBe('shared');
    const back = await put(created.body.id, { sharing_type: 'individual' });
    expect(back.status).toBe(200);
    expect(back.body.sharing_type).toBe('individual');
  });

  it('an unrelated edit of a linked Product keeps it Family', async () => {
    const created = await post({ name: 'PT Pack F', type: 'sessions', units: 5, professional_service_ids: [psId] });
    const res = await put(created.body.id, { description: 'Five sessions' });
    expect(res.status).toBe(200);
    expect(res.body.sharing_type).toBe('shared');
  });
});
