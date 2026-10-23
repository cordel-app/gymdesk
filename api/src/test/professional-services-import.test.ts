// #2004 — Max Capacity on gym Professional Services and Import Base Professional Services.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';

const PREFIX = `ps-import-${Date.now()}`;
let gymA: string;
let gymB: string;
let readOnlyGym: string;
let baseA: number;
let baseB: number;

const as = (gym: string) => ({ Authorization: TEST_AUTH_HEADER, 'x-gym-id': gym });

async function insertBase(name: string, capacity: number | null): Promise<number> {
  const { insertId } = await db.query(
    "INSERT INTO professional_services (gym_id, name, description, is_system, max_capacity, created_by) VALUES (NULL, ?, 'base desc', 0, ?, 'test')",
    [name, capacity],
  );
  return insertId;
}

beforeAll(async () => {
  gymA = await createTestGym('PS Import A');
  await createTestMembership(gymA, 'admin');
  gymB = await createTestGym('PS Import B');
  await createTestMembership(gymB, 'admin');
  readOnlyGym = await createTestGym('PS Import RO');
  await createTestMembership(readOnlyGym, 'front_desk');
  baseA = await insertBase(`${PREFIX}-alpha`, 12);
  baseB = await insertBase(`${PREFIX}-beta`, null);
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.query('DELETE FROM professional_services WHERE gym_id IS NULL AND name LIKE ?', [`${PREFIX}%`]);
  await db.end();
});

describe('max_capacity on a gym Professional Service', () => {
  it('persists on create and reports it', async () => {
    const res = await request.post('/professional-services').set(as(gymA)).send({ name: `${PREFIX}-cap`, max_capacity: 8 });
    expect(res.status).toBe(201);
    expect(res.body.max_capacity).toBe(8);
  });

  it('rejects zero, negative and fractional values', async () => {
    for (const bad of [0, -3, 2.5, 'abc']) {
      const res = await request.post('/professional-services').set(as(gymA)).send({ name: `${PREFIX}-bad`, max_capacity: bad });
      expect(res.status).toBe(400);
    }
  });

  it('edit keeps it when absent, changes it, and clears it with null', async () => {
    const created = await request.post('/professional-services').set(as(gymA)).send({ name: `${PREFIX}-edit`, max_capacity: 5 });
    const id = created.body.id;
    let res = await request.put(`/professional-services/${id}`).set(as(gymA)).send({ description: 'x' });
    expect(res.status).toBe(200);
    expect(res.body.max_capacity).toBe(5);
    res = await request.put(`/professional-services/${id}`).set(as(gymA)).send({ max_capacity: 9 });
    expect(res.body.max_capacity).toBe(9);
    res = await request.put(`/professional-services/${id}`).set(as(gymA)).send({ max_capacity: null });
    expect(res.body.max_capacity).toBeNull();
    res = await request.put(`/professional-services/${id}`).set(as(gymA)).send({ max_capacity: -1 });
    expect(res.status).toBe(400);
  });
});

describe('Import Base Professional Services', () => {
  it('is admin only', async () => {
    expect((await request.get('/professional-services/base').set(as(readOnlyGym))).status).toBe(403);
    expect((await request.post('/professional-services/import').set(as(readOnlyGym)).send({ base_professional_service_ids: [baseA] })).status).toBe(403);
    expect((await request.get('/professional-services/base')).status).toBe(401);
  });

  it('lists base services with this gym\'s import state', async () => {
    const res = await request.get(`/professional-services/base?q=${PREFIX}`).set(as(gymA));
    expect(res.status).toBe(200);
    expect(res.body.map((r: any) => r.name)).toEqual([`${PREFIX}-alpha`, `${PREFIX}-beta`]);
    expect(res.body.every((r: any) => r.imported === false)).toBe(true);
  });

  it('validates the body', async () => {
    for (const body of [{}, { base_professional_service_ids: [] }, { base_professional_service_ids: ['x'] }]) {
      const res = await request.post('/professional-services/import').set(as(gymA)).send(body);
      expect(res.status).toBe(400);
    }
    const res = await request.post('/professional-services/import').set(as(gymA)).send({ base_professional_service_ids: [99999999] });
    expect(res.status).toBe(404);
  });

  it('imports independent gym-owned copies, once, without touching the base or other gyms', async () => {
    const res = await request.post('/professional-services/import').set(as(gymA)).send({ base_professional_service_ids: [baseA, baseB] });
    expect(res.status).toBe(200);
    expect(res.body.imported.sort()).toEqual([baseA, baseB].sort());

    const list = await request.get('/professional-services').set(as(gymA));
    const copy = list.body.find((r: any) => r.base_professional_service_id === baseA);
    expect(copy).toMatchObject({ name: `${PREFIX}-alpha`, description: 'base desc', max_capacity: 12, gym_id: gymA, status: 'active', is_system: 0 });

    // Independent: editing the copy leaves the base alone.
    await request.put(`/professional-services/${copy.id}`).set(as(gymA)).send({ max_capacity: 3 });
    const { rows } = await db.query('SELECT max_capacity FROM professional_services WHERE id = ?', [baseA]);
    expect(rows[0].max_capacity).toBe(12);

    // Duplicate import is skipped, creates nothing.
    const again = await request.post('/professional-services/import').set(as(gymA)).send({ base_professional_service_ids: [baseA] });
    expect(again.body).toEqual({ imported: [], skipped: [baseA] });
    const { rows: count } = await db.query('SELECT COUNT(*) AS n FROM professional_services WHERE gym_id = ? AND base_professional_service_id = ?', [gymA, baseA]);
    expect(Number(count[0].n)).toBe(1);

    // Listing reports imported for gym A only.
    const a = await request.get(`/professional-services/base?q=${PREFIX}-alpha`).set(as(gymA));
    expect(a.body[0].imported).toBe(true);
    const b = await request.get(`/professional-services/base?q=${PREFIX}-alpha`).set(as(gymB));
    expect(b.body[0].imported).toBe(false);
    const bList = await request.get('/professional-services').set(as(gymB));
    expect(bList.body.some((r: any) => r.base_professional_service_id === baseA)).toBe(false);
  });

  it('allows re-import after the copy is deleted', async () => {
    const { rows } = await db.query('SELECT id FROM professional_services WHERE gym_id = ? AND base_professional_service_id = ?', [gymA, baseB]);
    expect((await request.delete(`/professional-services/${rows[0].id}`).set(as(gymA))).status).toBe(204);
    const res = await request.post('/professional-services/import').set(as(gymA)).send({ base_professional_service_ids: [baseB] });
    expect(res.body.imported).toEqual([baseB]);
  });

  it('skips a base service whose name the gym already uses', async () => {
    const taken = await insertBase(`${PREFIX}-gamma`, null);
    await request.post('/professional-services').set(as(gymB)).send({ name: `${PREFIX}-gamma` });
    const res = await request.post('/professional-services/import').set(as(gymB)).send({ base_professional_service_ids: [taken] });
    expect(res.body).toEqual({ imported: [], skipped: [taken] });
  });
});
